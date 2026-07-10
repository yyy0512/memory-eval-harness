```javascript
/**
 * StreamPulse Nexus – Shared Lib
 * Event Bus (Observer / Event–Driven backbone)
 *
 * This module is used by every single runtime module in the platform.  It
 * augments Node’s EventEmitter with:
 *   – Wild-card pattern listeners   (e.g. `media.*`, `*.error`, `**`)
 *   – Promise helpers               (waitFor, race)
 *   – One-shot listeners            (once)
 *   – Scoped / child buses          (isolation for dynamic plug-ins)
 *   – Optional inter-process bridge (cluster / worker-threads / child_proc)
 *
 *   All of the above is implemented in a *dependency-free* fashion except for
 *   UUID generation and debug logging (kept light-weight).
 *
 * NOTE: This file is published to “lib-shared” so **DO NOT** use any heavy
 *       dependencies that could leak into front-end bundles!
 */

import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';          // -> runtime UUIDs for tracing
import debugFactory from 'debug';           // -> conditional printf-style logging

const debug = debugFactory('streampulse:event-bus');

/* -------------------------------------------------------------------------- */
/*                               Helper utils                                 */
/* -------------------------------------------------------------------------- */

/**
 * Very small glob-like matcher.  Supports:
 *   – *  : one segment wildcard     (e.g. media.*  matches  media.start)
 *   – ** : multi-segment wildcard   (e.g. media.** matches  media.audio.muted)
 *
 * The implementation is intentionally simple and *sync* for perf.
 */
function matchTopic (pattern, topic) {
  if (pattern === topic || pattern === '**') return true;
  const pParts = pattern.split('.');
  const tParts = topic.split('.');

  let i = 0;
  let j = 0;

  while (i < pParts.length && j < tParts.length) {
    if (pParts[i] === '**') return true;
    if (pParts[i] !== '*' && pParts[i] !== tParts[j]) return false;
    i += 1;
    j += 1;
  }

  //  Remaining pattern can only be “**”
  return (i === pParts.length && j === tParts.length) ||
         (i === pParts.length - 1 && pParts[i] === '**');
}

/**
 * Wrap listener call in a try/catch so a single exception doesn’t kill the bus.
 */
function safeInvoke (listener, args, onError) {
  try {
    listener(...args);
  } catch (err) {
    onError(err);
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Bus                                       */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} BusOptions
 * @prop {number}  [maxListeners]      – forwarded to EventEmitter
 * @prop {boolean} [bridgeProcess]     – mirror events into `process.send`
 * @prop {string}  [scope]             – dotted prefix prepended to every topic
 */

export default class EventBus extends EventEmitter {
  /**
   * @param {BusOptions} [options]
   */
  constructor (options = {}) {
    super({ captureRejections: true });
    const { maxListeners = 1000, bridgeProcess = false, scope = '' } = options;

    this.setMaxListeners(maxListeners);

    /**
     * Internal maps for wild-card subscriptions
     *   Map<pattern, Set<Function>>
     * Used only if pattern contains “*” or “**”
     */
    this._wildcardListeners = new Map();

    /** Unique id for tracing in logs */
    this.id = uuid();
    this.scope = scope ? `${scope}.` : '';

    /** Bridge to parent/worker process if enabled */
    if (bridgeProcess && typeof process.send === 'function') {
      debug('process bridging enabled (%s)', this.id);
      //  Relay outbound
      this.onAny((topic, ...argz) => {
        try {
          process.send({ __nexusEvent: true, topic, payload: argz });
        } catch (_) {}   // process disconnected – silent
      });
      //  Relay inbound
      process.on('message', msg => {
        if (msg && msg.__nexusEvent && Array.isArray(msg.payload)) {
          debug('<= bridged (%s) %s', this.id, msg.topic);
          this.emitLocal(msg.topic, ...msg.payload);
        }
      });
    }

    /* Capture emission errors to avoid “unhandled rejection” explosions */
    this.on('error', err => {
      //  Could integrate with central logging here
      // eslint-disable-next-line no-console
      console.error('[EventBus] listener error:', err);
    });
  }

  /* ---------------------------------------------------------------------- */
  /*                       Public API (augmentations)                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Emit an event.  Returns a boolean indicating if any listener handled it.
   */
  emit (topic, ...args) {
    const scopedTopic = this.scope + topic;
    debug('> %s (%s listeners)', scopedTopic, this.listenerCount(scopedTopic));
    const handled = this.emitLocal(scopedTopic, ...args);

    //  Wild-card listeners
    const wcHandled = this._emitWildcard(scopedTopic, ...args);

    return handled || wcHandled;
  }

  /**
   * Register a listener for an event or glob-pattern.
   *
   * @param {string} pattern
   * @param {Function} listener
   */
  on (pattern, listener) {
    if (typeof pattern !== 'string' || typeof listener !== 'function') {
      throw new TypeError('on(pattern, listener) requires (string, function)');
    }

    const scopedPattern = this.scope + pattern;

    if (scopedPattern.includes('*')) {
      //  Wild-card
      let set = this._wildcardListeners.get(scopedPattern);
      if (!set) {
        set = new Set();
        this._wildcardListeners.set(scopedPattern, set);
      }
      set.add(listener);
      debug('listener added (wildcard) %s', scopedPattern);
      return this;
    }

    debug('listener added %s', scopedPattern);
    return super.on(scopedPattern, listener);
  }

  once (pattern, listener) {
    const wrapper = (...args) => {
      this.off(pattern, wrapper);
      listener(...args);
    };
    return this.on(pattern, wrapper);
  }

  /**
   * Remove listener(s).  Works with both exact & wildcard patterns.
   */
  off (pattern, listener) {
    const scopedPattern = this.scope + pattern;

    if (scopedPattern.includes('*')) {
      const set = this._wildcardListeners.get(scopedPattern);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this._wildcardListeners.delete(scopedPattern);
      }
      return this;
    }
    return super.off(scopedPattern, listener);
  }

  /**
   * Returns a Promise that resolves the first time the `pattern` fires or
   * rejects after `timeoutMs`.
   *
   * @param {string} pattern
   * @param {number} [timeoutMs]
   */
  waitFor (pattern, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(pattern, onEvent);
        reject(new Error(`EventBus.waitFor timeout (${pattern})`));
      }, timeoutMs);

      const onEvent = (...payload) => {
        clearTimeout(timer);
        resolve(payload.length === 1 ? payload[0] : payload);
      };

      this.once(pattern, onEvent);
    });
  }

  /**
   * Fire event and wait until at least one listener handled it (or time out).
   * Use-case: command + ack flow in Chain-of-Responsibility.
   */
  async emitAndWait (topic, payload, timeoutMs = 5_000) {
    const catcher = Symbol('emitAndWaitTmp');
    const ackPromise = this.waitFor(catcher, timeoutMs);

    this.emit(topic, payload, (ack = true) => {
      this.emitLocal(catcher, ack);
    });

    return ackPromise;
  }

  /**
   * Attach a bus so every event from `source` is re-emitted locally.
   * Useful for module federation.
   */
  pipe (sourceBus) {
    if (!(sourceBus instanceof EventBus)) {
      throw new TypeError('pipe() expects an EventBus instance');
    }
    sourceBus.onAny((t, ...a) => this.emitLocal(t, ...a));
    return () => sourceBus.removeListenerAny((t, ...a) => this.emitLocal(t, ...a));
  }

  /**
   * Create a child bus with the given dotted scope prefix.
   */
  createScopedBus (scope) {
    return new EventBus({
      maxListeners: this.getMaxListeners(),
      scope: this.scope + scope,
    });
  }

  /* ---------------------------------------------------------------------- */
  /*                       Private helpers / internals                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Emit event without scope translation or wild-card expansion.
   * Mirrors EventEmitter.emit but guarded.
   *
   * @private
   */
  emitLocal (topic, ...args) {
    //  Capture errors from listeners (required because captureRejections only
    //  handles Promise rejections, not sync throws)
    const listeners = this.listeners(topic);
    listeners.forEach(listener => safeInvoke(listener, args, err => this.emit('error', err)));
    return listeners.length > 0;
  }

  /**
   * Deliver event to all wildcard listeners that match.
   *
   * @private
   */
  _emitWildcard (topic, ...args) {
    let delivered = false;
    for (const [pattern, listeners] of this._wildcardListeners) {
      if (matchTopic(pattern, topic)) {
        listeners.forEach(fn => safeInvoke(fn, args, err => this.emit('error', err)));
        delivered = true;
      }
    }
    return delivered;
  }

  /* ---------------------------------------------------------------------- */
  /*                    Any-Listener (utility for debugging)                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Register a listener that receives `(topic, ...args)` for *every* event.
   */
  onAny (listener) {
    this.on('**', listener);
  }

  removeListenerAny (listener) {
    this.off('**', listener);
  }
}

/* -------------------------------------------------------------------------- */
/*                              Singleton Export                              */
/* -------------------------------------------------------------------------- */

/**
 * While most server code will instantiate their own bus, some front-end
 * widgets want a quick singleton (similar to a Redux store).  To avoid import
 * cycles use:
 *
 *   import eventBus, { EventBus } from '...eventBus.js';
 */
export const defaultBus = new EventBus();
export { defaultBus as bus };
```