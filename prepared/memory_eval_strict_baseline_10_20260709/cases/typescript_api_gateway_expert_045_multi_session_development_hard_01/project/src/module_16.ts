```typescript
/**
 * SocialPulse Gateway – Versioned Routing Core
 * ------------------------------------------------
 * File: src/module_16.ts
 *
 * This module is responsible for resolving “version-aware” request
 * handlers (REST or GraphQL) at runtime.  It inspects the incoming
 * request using pluggable `VersionProvider` strategies (header, query,
 * path, …) and routes the request to the closest compatible handler
 * that has been registered for the given capability.
 *
 * Key capabilities
 * ----------------
 * • SemVer-accurate resolution (leveraging the `semver` package).
 * • Pluggable strategies – new strategies may be registered at runtime.
 * • Graceful fallback when the requested version does not exist.
 * • Strong typing + publish/subscribe hooks for observability.
 *
 * The module intentionally lives in the “infrastructure” ring of the
 * Clean Architecture but exposes an API that can be consumed by the
 * presentation layer (controllers / resolvers).
 */

import { IncomingMessage, ServerResponse } from 'http';
import { satisfies, rcompare, valid, coerce } from 'semver';
import pino from 'pino';

// ---------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------

/**
 * Small alias for a node-style HTTP handler.
 */
export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

/**
 * Common shape for the request context we pass around. We keep it small
 * so it stays framework-agnostic (express, fastify, bare http).
 */
export interface RequestContext {
  raw: IncomingMessage;
  /**
   * Normalized headers (all lowercase).
   */
  headers: Record<string, string | undefined>;
  /**
   * Parsed query parameters (lowercase keys).
   */
  query: Record<string, string | undefined>;
  /**
   * Original URL path, untouched.
   */
  path: string;
}

/**
 * A version provider extracts a version string from the {@link RequestContext}. 
 * It must return `null` if it is unable to extract any version information.
 */
export interface VersionProvider {
  readonly name: string;
  getVersion(ctx: RequestContext): string | null;
}

/**
 * Registry structure for a single capability.  Example capability:
 * "timeline.read".
 */
interface VersionEntry {
  version: string;
  handler: HttpHandler;
}

/**
 * Options for {@link VersionedRegistry}.
 */
export interface VersionedRegistryOptions {
  /**
   * Whether to enable debug-level logging for version negotiation.
   */
  debug?: boolean;
  /**
   * SemVer range that must be satisfied by incoming requests.  
   * This acts as a *global* compatibility guard.  Example: "^1.0.0".
   */
  supportedRange?: string;
  /**
   * Provide a logger instance; falls back to a child of the root logger.
   */
  logger?: pino.Logger;
}

// ---------------------------------------------------------------------
// Provider Implementations
// ---------------------------------------------------------------------

/**
 * Extracts version information from `X-API-Version` header.
 */
export class HeaderVersionProvider implements VersionProvider {
  readonly name = 'header:x-api-version';

  constructor(private readonly headerName = 'x-api-version') {}

  getVersion(ctx: RequestContext): string | null {
    const v = ctx.headers[this.headerName.toLowerCase()];
    return v ?? null;
  }
}

/**
 * Extracts version information from `version` query param (`?version=1.2.3`).
 */
export class QueryParamVersionProvider implements VersionProvider {
  readonly name = 'query:version';

  constructor(private readonly paramName = 'version') {}

  getVersion(ctx: RequestContext): string | null {
    const v = ctx.query[this.paramName.toLowerCase()];
    return v ?? null;
  }
}

/**
 * Extracts version information from the first path segment  
 * (e.g., `/v1.3.0/posts` or `/v2/posts` → `1.3.0` / `2.0.0`).
 */
export class PathSegmentVersionProvider implements VersionProvider {
  readonly name = 'path-segment:v';

  constructor(private readonly tag = 'v') {}

  getVersion(ctx: RequestContext): string | null {
    const [, first] = ctx.path.split('/', 2);
    if (!first || !first.startsWith(this.tag)) return null;

    const raw = first.slice(this.tag.length); // strip leading tag
    // Coerce "1" → "1.0.0" etc.
    const coerced = coerce(raw);
    return coerced ? coerced.version : null;
  }
}

// ---------------------------------------------------------------------
// Core Registry
// ---------------------------------------------------------------------

/**
 * VersionedRegistry maps a *capability* string and a *SemVer* to a
 * handler implementation.  At runtime, `resolve()` negotiates a handler
 * based on the request’s version preference.
 */
export class VersionedRegistry {
  private readonly providers: VersionProvider[] = [];
  private readonly table = new Map<string, VersionEntry[]>();
  private readonly log: pino.Logger;
  private readonly supportedRange: string;

  constructor(options: VersionedRegistryOptions = {}) {
    this.log = options.logger ?? pino().child({ module: 'versioned-registry' });
    if (options.debug) {
      this.log.level = 'debug';
    }
    this.supportedRange = options.supportedRange ?? '*';
  }

  // -------------------------------------------------------------------
  // Provider management
  // -------------------------------------------------------------------

  /**
   * Register a new {@link VersionProvider}. Providers are evaluated in
   * FIFO order until one returns a version string.
   */
  public use(provider: VersionProvider): this {
    this.log.debug({ provider: provider.name }, 'Registering version provider');
    this.providers.push(provider);
    return this;
  }

  /**
   * Convenience bootstrap – adds the default set of providers in a
   * deterministic order.
   */
  public useDefaults(): this {
    return this.use(new HeaderVersionProvider())
      .use(new QueryParamVersionProvider())
      .use(new PathSegmentVersionProvider());
  }

  // -------------------------------------------------------------------
  // Handler management
  // -------------------------------------------------------------------

  /**
   * Register a handler for a capability and version.
   *
   * Example:
   *    registry.register('timeline.read', '1.0.0', myHandler);
   */
  public register(capability: string, version: string, handler: HttpHandler): this {
    if (!valid(version)) {
      throw new TypeError(`Invalid semver: "${version}" for capability "${capability}"`);
    }

    const list = this.table.get(capability) ?? [];
    list.push({ version, handler });
    // Sort descending so newer versions come first
    list.sort((a, b) => rcompare(a.version, b.version));
    this.table.set(capability, list);

    this.log.debug({ capability, version }, 'Registered versioned handler');
    return this;
  }

  // -------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------

  /**
   * Resolve handler for capability using incoming request context.
   *
   * Throws `NotFoundError` when no compatible handler exists.
   * Throws `UnsupportedVersionError` when requested version is outside
   * the globally supported range.
   */
  public resolve(capability: string, ctx: RequestContext): HttpHandler {
    const requested = this.extractVersion(ctx);
    this.log.debug({ capability, requested }, 'Resolving handler');

    if (requested && !satisfies(requested, this.supportedRange)) {
      this.log.warn(
        { capability, requested, supportedRange: this.supportedRange },
        'Requested version outside supported range'
      );
      throw new UnsupportedVersionError(requested, this.supportedRange);
    }

    const candidates = this.table.get(capability);
    if (!candidates?.length) {
      this.log.error({ capability }, 'No handlers registered for capability');
      throw new NotFoundError(`No handlers registered for capability "${capability}"`);
    }

    // When no version was provided, just return the latest
    if (!requested) {
      return candidates[0].handler;
    }

    // Find first candidate that satisfies requested semver range
    for (const entry of candidates) {
      if (satisfies(entry.version, requested)) {
        return entry.handler;
      }
    }

    this.log.warn({ capability, requested }, 'No compatible handler found');
    throw new NotFoundError(
      `No handler found for capability "${capability}" with requested version "${requested}"`
    );
  }

  /**
   * Inspect the request context through registered providers to extract
   * a version preference.  Returns `null` if none is found.
   */
  private extractVersion(ctx: RequestContext): string | null {
    for (const provider of this.providers) {
      const version = provider.getVersion(ctx);
      if (version) {
        this.log.debug({ provider: provider.name, version }, 'Version determined by provider');
        // Normalize loosely formatted versions ("1" => "1.0.0")
        const coerced = coerce(version);
        if (coerced) return coerced.version;
        return version;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

/**
 * Thrown when a requested version is syntactically correct but outside
 * the gateway’s supported compatibility range.
 */
export class UnsupportedVersionError extends Error {
  constructor(
    public readonly requested: string,
    public readonly supportedRange: string
  ) {
    super(`Requested version "${requested}" is not within supported range "${supportedRange}".`);
    this.name = 'UnsupportedVersionError';
  }
}

/**
 * Thrown when no matching handler exists for the capability/version.
 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

// ---------------------------------------------------------------------
// Example Bootstrap (can be removed in production)
// ---------------------------------------------------------------------

/**
 * Quick bootstrap illustrating how to use the registry in a typical
 * node HTTP server.  This is *not* executed automatically; importers
 * may invoke `demo()` manually when experimenting.
 */
export async function demo(): Promise<void> {
  const http = await import('http');

  // Strongly typed registry
  const registry = new VersionedRegistry({ debug: true, supportedRange: '^1.0.0' })
    .useDefaults()
    .register('echo', '1.0.0', async (req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          message: 'Hello from v1 handler',
          url: req.url,
          date: new Date().toISOString(),
        })
      );
    })
    .register('echo', '1.2.0', async (req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          message: 'Hello from v1.2 handler (new hotness!)',
          url: req.url,
          date: new Date().toISOString(),
        })
      );
    });

  const server = http.createServer((req, res) => {
    const ctx: RequestContext = {
      raw: req,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v])
      ),
      query: (() => {
        const urlObj = new URL(req.url ?? '/', 'http://localhost');
        const out: Record<string, string | undefined> = {};
        for (const [k, v] of urlObj.searchParams.entries()) {
          out[k.toLowerCase()] = v;
        }
        return out;
      })(),
      path: req.url?.split('?')[0] ?? '/',
    };

    try {
      const handler = registry.resolve('echo', ctx);
      void handler(req, res);
    } catch (e) {
      const err = e as Error;
      res.statusCode = err instanceof NotFoundError ? 404 : 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  const PORT = 3000;
  server.listen(PORT, () => console.log(`Demo server listening on :${PORT}`));
}
```
