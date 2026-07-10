/**
 * Domain Aggregate: Comment
 * -------------------------------------------------------
 * Represents a user-generated comment on a transaction/post
 * in the PayPalsphere social graph.  Implements an event-sourced
 * aggregate root with simple in-memory event buffering.
 *
 * Responsibility:
 *  - Validate & sanitise user input
 *  - Emit immutable domain events
 *  - Apply events to build current state
 *  - Expose business operations (edit, delete, flag, like, etc.)
 *
 * NOTE: Persistence/replay, saga orchestration, and projection
 *       layers are handled outside of this aggregate.
 */

'use strict';

const { v4: uuidv4 }           = require('uuid');
const EventEmitter             = require('events');
const sanitizeHtml             = require('sanitize-html');
const Filter                   = require('bad-words');
const crypto                   = require('crypto');

/**
 * Helpers
 * -----------------------------------------------------*/

/**
 * Very thin profanity blocker.  Can be replaced with a
 * ML-based service in higher environments.
 */
const profanityFilter = new Filter();

/**
 * Field-level encryption helpers.
 * Symmetric AES-256-GCM with random IV + auth tag.
 */
const ALGO        = 'aes-256-gcm';
const KEY         = process.env.COMMENT_CIPHER_KEY || crypto.randomBytes(32);
const IV_LENGTH   = 16; // 128-bit

function encrypt(plainText) {
    const iv     = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGO, KEY, iv);

    const encrypted   = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
    const authTag     = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(cipherText) {
    const [ivHex, tagHex, dataHex] = cipherText.split(':');
    if (!ivHex || !tagHex || !dataHex) throw new Error('Malformed ciphertext');

    const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(dataHex, 'hex')),
        decipher.final(),
    ]);

    return decrypted.toString('utf8');
}

/**
 * Error subclass for domain-specific problems.
 */
class DomainError extends Error {
    constructor(message, code = 'DOMAIN_ERROR') {
        super(message);
        this.name = 'DomainError';
        this.code = code;
        Error.captureStackTrace(this, DomainError);
    }
}

/**
 * Event Types
 * ---------------------------------------------------*/
const EVENT = Object.freeze({
    CREATED:        'COMMENT_CREATED',
    EDITED:         'COMMENT_EDITED',
    DELETED:        'COMMENT_DELETED',
    FLAGGED:        'COMMENT_FLAGGED',
    LIKE_ADDED:     'COMMENT_LIKE_ADDED',
    LIKE_REMOVED:   'COMMENT_LIKE_REMOVED',
});

/**
 * Aggregate Root: Comment
 * ---------------------------------------------------*/
class Comment extends EventEmitter {

    /**
     * Instantiate from scratch or from snapshot.
     * @param {Object} snapshot - Optional persisted state.
     */
    constructor(snapshot = {}) {
        super();

        // Internal State (NOT to be accessed directly from outside)
        this._state = {
            id:             snapshot.id             || uuidv4(),
            postId:         snapshot.postId         || null,       // ID of the transaction or post
            authorId:       snapshot.authorId       || null,
            content:        snapshot.content        || null,       // encrypted string
            createdAt:      snapshot.createdAt      || null,
            updatedAt:      snapshot.updatedAt      || null,
            deletedAt:      snapshot.deletedAt      || null,
            likes:          snapshot.likes          || new Set(),  // Set<string> userIds
            flags:          snapshot.flags          || new Set(),  // Set<string> userIds
            version:        snapshot.version        || 0,          // event version
        };

        // In-memory buffer for uncommitted events (to be persisted by infrastructure layer)
        this._uncommitted = [];
    }

    /* -------------------------------------------------- *
     * Business Operations
     * -------------------------------------------------- */

    /**
     * Factory method – create a new comment.
     */
    static create({ postId, authorId, content }) {
        const instance = new Comment();
        instance._raise({
            type:     EVENT.CREATED,
            payload:  {
                postId,
                authorId,
                content,
                occursAt: new Date().toISOString(),
            },
        });
        return instance;
    }

    /**
     * Edit the comment text (only author allowed, unless
     * admin privileges are provided via `opts.force = true`).
     */
    edit(newContent, actorId, opts = {}) {
        this._ensureNotDeleted();
        this._ensureAuthorOrForce(actorId, opts);
        this._raise({
            type: EVENT.EDITED,
            payload: {
                newContent,
                actorId,
                occursAt: new Date().toISOString(),
            },
        });
    }

    /**
     * Soft-delete a comment.
     */
    delete(actorId, opts = {}) {
        this._ensureNotDeleted();
        this._ensureAuthorOrForce(actorId, opts);
        this._raise({
            type: EVENT.DELETED,
            payload: {
                actorId,
                occursAt: new Date().toISOString(),
            },
        });
    }

    /**
     * Flag a comment for moderation.
     */
    flag(actorId) {
        if (this._state.flags.has(actorId)) {
            throw new DomainError('Already flagged by this user', 'ALREADY_FLAGGED');
        }
        this._raise({
            type: EVENT.FLAGGED,
            payload: {
                actorId,
                occursAt: new Date().toISOString(),
            },
        });
    }

    /**
     * Add a like.
     */
    like(actorId) {
        if (this._state.likes.has(actorId)) {
            throw new DomainError('Already liked', 'ALREADY_LIKED');
        }
        this._raise({
            type: EVENT.LIKE_ADDED,
            payload: {
                actorId,
                occursAt: new Date().toISOString(),
            },
        });
    }

    /**
     * Remove like.
     */
    unlike(actorId) {
        if (!this._state.likes.has(actorId)) {
            throw new DomainError('Like not found', 'LIKE_NOT_FOUND');
        }
        this._raise({
            type: EVENT.LIKE_REMOVED,
            payload: {
                actorId,
                occursAt: new Date().toISOString(),
            },
        });
    }

    /* -------------------------------------------------- *
     * Public Read-only Getters
     * -------------------------------------------------- */

    get id()            { return this._state.id; }
    get postId()        { return this._state.postId; }
    get authorId()      { return this._state.authorId; }
    get createdAt()     { return this._state.createdAt; }
    get updatedAt()     { return this._state.updatedAt; }
    get deletedAt()     { return this._state.deletedAt; }
    get version()       { return this._state.version; }

    /**
     * Return decrypted content.  Use cautiously.
     */
    getContent() {
        return this._state.content ? decrypt(this._state.content) : null;
    }

    /**
     * Public representation safe for JSON.stringify
     * (still contains encrypted content).
     */
    toJSON() {
        return {
            id:         this._state.id,
            postId:     this._state.postId,
            authorId:   this._state.authorId,
            content:    this._state.content, // encrypted
            createdAt:  this._state.createdAt,
            updatedAt:  this._state.updatedAt,
            deletedAt:  this._state.deletedAt,
            likes:      Array.from(this._state.likes),
            flags:      Array.from(this._state.flags),
            version:    this._state.version,
        };
    }

    /**
     * Expose and flush uncommitted events (infrastructure layer
     * will persist & publish them, then call `markCommitted`).
     */
    pullUncommittedEvents() {
        const events = [...this._uncommitted];
        return events;
    }

    /**
     * After persistence, framework calls this to clear buffer.
     */
    markCommitted() {
        this._uncommitted.length = 0;
    }

    /* -------------------------------------------------- *
     * Internal Utilities
     * -------------------------------------------------- */

    /**
     * Centralised validation / sanitisation function.
     */
    static _validateAndSanitiseContent(raw) {
        if (!raw || typeof raw !== 'string') {
            throw new DomainError('Content must be a non-empty string', 'INVALID_CONTENT');
        }
        if (raw.length > 1000) {
            throw new DomainError('Content is too long', 'CONTENT_TOO_LONG');
        }
        if (profanityFilter.isProfane(raw)) {
            throw new DomainError('Content contains prohibited language', 'PROFANITY_BLOCKED');
        }
        // Strip disallowed HTML tags to mitigate XSS
        return sanitizeHtml(raw, {
            allowedTags:   ['b', 'i', 'em', 'strong', 'a'],
            allowedAttributes: { 'a': ['href', 'title', 'target'] },
            allowedSchemes:  ['http', 'https', 'mailto'],
        });
    }

    /**
     * Apply domain invariants
     */
    _ensureNotDeleted() {
        if (this._state.deletedAt) {
            throw new DomainError('Comment has been deleted', 'ALREADY_DELETED');
        }
    }

    _ensureAuthorOrForce(actorId, opts) {
        const isAuthor = actorId === this._state.authorId;
        if (!isAuthor && !opts.force) {
            throw new DomainError('Operation not permitted', 'FORBIDDEN');
        }
    }

    /**
     * Event factory + applier.
     */
    _raise(event) {
        // Optimistic version increment
        event.version  = ++this._state.version;
        this._apply(event);
        this._uncommitted.push(event);
        this.emit('event', event); // Allow listeners (e.g., denormalisers) to react immediately
    }

    /**
     * Event Router
     */
    _apply(event) {
        switch (event.type) {
            case EVENT.CREATED:      return this._onCreated(event);
            case EVENT.EDITED:       return this._onEdited(event);
            case EVENT.DELETED:      return this._onDeleted(event);
            case EVENT.FLAGGED:      return this._onFlagged(event);
            case EVENT.LIKE_ADDED:   return this._onLikeAdded(event);
            case EVENT.LIKE_REMOVED: return this._onLikeRemoved(event);
            default:
                throw new DomainError(`Unhandled event type: ${event.type}`, 'UNKNOWN_EVENT');
        }
    }

    /* -------------------------------------------------- *
     * Event Handlers
     * -------------------------------------------------- */

    _onCreated({ payload }) {
        const sanitised = Comment._validateAndSanitiseContent(payload.content);
        this._state.postId    = payload.postId;
        this._state.authorId  = payload.authorId;
        this._state.content   = encrypt(sanitised);
        this._state.createdAt = payload.occursAt;
        this._state.updatedAt = payload.occursAt;
    }

    _onEdited({ payload }) {
        const sanitised        = Comment._validateAndSanitiseContent(payload.newContent);
        this._state.content    = encrypt(sanitised);
        this._state.updatedAt  = payload.occursAt;
    }

    _onDeleted({ payload }) {
        this._state.deletedAt  = payload.occursAt;
        this._state.updatedAt  = payload.occursAt;
    }

    _onFlagged({ payload }) {
        this._state.flags.add(payload.actorId);
        this._state.updatedAt  = payload.occursAt;
    }

    _onLikeAdded({ payload }) {
        this._state.likes.add(payload.actorId);
        this._state.updatedAt  = payload.occursAt;
    }

    _onLikeRemoved({ payload }) {
        this._state.likes.delete(payload.actorId);
        this._state.updatedAt  = payload.occursAt;
    }
}

/* -------------------------------------------------------- *
 * Exports
 * -------------------------------------------------------- */

module.exports = {
    Comment,
    EVENT,
    DomainError,
};
