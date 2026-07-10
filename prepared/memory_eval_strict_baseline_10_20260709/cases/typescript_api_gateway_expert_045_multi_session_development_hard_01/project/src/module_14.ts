```typescript
/**
 * SocialPulse Gateway
 * File: src/module_14.ts
 *
 * Purpose
 * -------
 * Centralised JSON-Schema–based request-validation layer used by both
 * HTTP (REST) controllers and GraphQL resolvers.  The implementation
 * wraps the excellent “ajv” validator, adds type-safe helpers, an LRU
 * cache for compiled schemas, and uniform error handling so that
 * validation failures are logged and surfaced to clients in a
 * predictable (RFC-7807) format.
 *
 * The module is framework-agnostic, but ships with convenience
 * middleware for Express as that is what powers the HTTP ingress of
 * SocialPulse Gateway.  For GraphQL callers, a utility is exported so
 * resolvers can invoke the same validation logic in an imperative
 * style.
 */

import LRUCache from 'lru-cache';
import Ajv, { ErrorObject, ValidateFunction, Options as AjvOptions } from 'ajv';
import addFormats from 'ajv-formats';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import httpStatus from 'http-status';
import { Logger } from './infrastructure/logger';

/* ------------------------------------------------------------------ */
/* Types & Constants                                                  */
/* ------------------------------------------------------------------ */

/**
 * Object shape returned to API consumers when validation fails.
 * Mirrors RFC-7807 (“Problem Details for HTTP APIs”).
 */
export interface ValidationProblem {
  type: string;
  title: string;
  status: number;
  detail: string;
  errors: Record<string, string>;
}

/**
 * Options that callers can override when validating a payload.
 */
export interface ValidatorOptions {
  /**
   * Should type coercion be enabled? Defaults to true so that strings
   * like "1" can match integer schemas.
   */
  readonly coerceTypes?: boolean;

  /**
   * If a schema has sensible defaults for missing fields, we can
   * choose to automatically populate them before the object reaches
   * business logic.
   */
  readonly useDefaults?: boolean;
}

/* ------------------------------------------------------------------ */
/* Internal Utilities                                                 */
/* ------------------------------------------------------------------ */

const DEFAULT_AJV_OPTIONS: AjvOptions = {
  allErrors: true,
  strict: false, // Allow more lenience for evolving schemas.
  coerceTypes: true,
  useDefaults: true,
  removeAdditional: 'failing', // Disallow rogue properties.
};

const log = Logger.child({ module: 'request-validation' });

/**
 * Simple singleton around AJV with LRU-cached compiled validators.
 */
class SchemaCompiler {
  private readonly ajv: Ajv;
  private readonly cache: LRUCache<string, ValidateFunction>;

  constructor() {
    this.ajv = new Ajv(DEFAULT_AJV_OPTIONS);
    addFormats(this.ajv);

    // Cache up to 5k compiled schemas – enough for thousands of micro-versions.
    this.cache = new LRUCache({ max: 5000 });
  }

  /**
   * Registers a new JSON schema.
   */
  registerSchema(id: string, schema: object): void {
    if (this.cache.has(id) || this.ajv.getSchema(id)) {
      log.warn({ id }, 'Schema already registered: skipping');
      return;
    }
    this.ajv.addSchema(schema, id);
    log.debug({ id }, 'Registered schema');
  }

  /**
   * Compile or retrieve a cached validator function for given schema id.
   */
  getValidator(id: string, override?: ValidatorOptions): ValidateFunction {
    const cacheKey = this.generateCacheKey(id, override);

    let validator = this.cache.get(cacheKey);
    if (validator) return validator;

    // Merge override options for this compilation.
    const options: AjvOptions = {
      ...DEFAULT_AJV_OPTIONS,
      ...override,
    };

    // AJV instance is immutable for options; clone w/ overrides.
    const ajv = new Ajv(options);
    addFormats(ajv);

    validator = ajv.getSchema(id) ?? ajv.compile(this.requireSchema(id));
    this.cache.set(cacheKey, validator);

    return validator;
  }

  private generateCacheKey(id: string, override?: ValidatorOptions): string {
    const keyParts = [`id:${id}`];
    if (override?.coerceTypes !== undefined) keyParts.push(`coerce:${override.coerceTypes}`);
    if (override?.useDefaults !== undefined) keyParts.push(`defaults:${override.useDefaults}`);
    return keyParts.join('|');
  }

  /**
   * Gets the raw schema object registered under the provided id or
   * throws if missing – this is fatal configuration error.
   */
  private requireSchema(id: string): object {
    const schema = this.ajv.getSchema(id)?.schema;
    if (!schema) {
      throw new Error(`Schema not found – id="${id}"`);
    }
    return schema;
  }
}

const schemaCompiler = new SchemaCompiler();

/* ------------------------------------------------------------------ */
/* Error Handling                                                     */
/* ------------------------------------------------------------------ */

/**
 * ValidationError is thrown internally and caught by the framework’s
 * global error handler.  For GraphQL, resolvers can catch and map to
 * ApolloError.  For REST, Express middleware returns
 * RFC-7807 structured JSON with status 422.
 */
export class ValidationError extends Error {
  public readonly problem: ValidationProblem;

  constructor(errors: ErrorObject[] = []) {
    const detail = 'One or more validation errors occurred';
    super(detail);

    const formatted: Record<string, string> = {};
    for (const e of errors) {
      const property = e.instancePath.replace(/^\//, '') || e.params.missingProperty || 'root';
      formatted[property] = e.message ?? 'invalid';
    }

    this.problem = {
      type: 'https://socialpulse.dev/problems/validation-error',
      title: 'Validation Error',
      status: httpStatus.UNPROCESSABLE_ENTITY,
      detail,
      errors: formatted,
    };

    // Maintains proper stack for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ValidationError);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Registers the given schema object, making it available for
 * validation.  MUST be called at application bootstrap.
 *
 * Example:
 *   registerSchema('CreatePost', createPostSchema);
 */
export const registerSchema = schemaCompiler.registerSchema.bind(schemaCompiler);

/**
 * Returns an Express middleware which validates `req.body` against the
 * specified schema.  If validation fails, the middleware short-circuits
 * the request with 422 Unprocessable Entity.
 *
 * Example:
 *   router.post(
 *     '/posts',
 *     validateRequest('CreatePost'),
 *     createPostController,
 *   );
 */
export function validateRequest(
  schemaId: string,
  options?: ValidatorOptions,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const validator = schemaCompiler.getValidator(schemaId, options);

      // Clone to prevent AJV `useDefaults` from mutating req.body directly.
      const payload = structuredClone(req.body);

      if (!validator(payload)) {
        throw new ValidationError(validator.errors ?? undefined);
      }

      // Replace body with possibly default-augmented payload
      req.body = payload;
      next();
    } catch (err) {
      if (err instanceof ValidationError) {
        log.info(
          { errors: err.problem.errors, path: req.path, method: req.method },
          'Request validation failed',
        );
        return res.status(err.problem.status).json(err.problem);
      }

      // Recoverable system error? Pass to global error handler.
      next(err as Error);
    }
  };
}

/**
 * Validates an arbitrary object (useful for GraphQL input objects).
 *
 * Example:
 *   try {
 *     validateObject('CreatePost', input);
 *   } catch (e) {
 *     if (e instanceof ValidationError) {
 *       return new ApolloError(e.problem.detail, 'VALIDATION_FAILED', {
 *         validation: e.problem.errors,
 *       });
 *     }
 *   }
 */
export function validateObject<T = unknown>(
  schemaId: string,
  obj: T,
  options?: ValidatorOptions,
): asserts obj is T {
  const validator = schemaCompiler.getValidator(schemaId, options);
  const clone = structuredClone(obj);
  if (!validator(clone)) {
    throw new ValidationError(validator.errors ?? undefined);
  }
}

/* ------------------------------------------------------------------ */
/* Hot Reload Safety (dev only)                                       */
/* ------------------------------------------------------------------ */
/**
 * During local development, the code can be reloaded multiple times
 * (e.g. via ts-node-dev). Ensure we reuse the same singleton to
 * prevent duplicate schema registration and memory bloat.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
if (global.__SOCIALPULSE_SCHEMA_COMPILER__) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  module.exports = global.__SOCIALPULSE_SCHEMA_COMPILER__;
} else {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  global.__SOCIALPULSE_SCHEMA_COMPILER__ = module.exports;
}
```