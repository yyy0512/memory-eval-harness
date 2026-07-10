```typescript
/**************************************************************************************************
 *  SocialPulse Gateway – Runtime Configuration
 *  -------------------------------------------------------------
 *  This module provides a fully-typed, runtime-validated configuration object for the gateway.
 *  All environment variables are eagerly validated on process start-up using Zod so that the
 *  application fails fast and loudly in case of misconfiguration.
 *
 *  Usage:
 *      import { config } from './config';
 *      console.log(config.app.port);
 *
 *  IMPORTANT: Do NOT import this module inside files that are executed before dotenv/config
 *  (e.g., cli entrypoints that explicitly call `dotenv.config()`), otherwise the order of
 *  environment resolution will be reversed.
 **************************************************************************************************/

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import 'dotenv/config'; // auto-loads .env into process.env

/**************************************************************************************************
 * Helpers
 **************************************************************************************************/

/**
 * Reads a key file from the filesystem. Will throw an error if the file cannot be found but will
 * tolerate empty paths (treated as undefined keys).
 */
function loadKeyFile(absPath: string | undefined): string | undefined {
    if (!absPath) return undefined;
    try {
        return fs.readFileSync(path.resolve(absPath), 'utf8').trim();
    } catch (err) {
        throw new Error(
            `[config] Failed to read key file at "${absPath}": ${(err as Error).message}`,
        );
    }
}

/**************************************************************************************************
 * Environment Schema
 **************************************************************************************************/

// Allowed NODE_ENV values
const nodeEnvSchema = z.enum(['development', 'test', 'staging', 'production']);

const envSchema = z.object({
    NODE_ENV: nodeEnvSchema.default('development'),

    /* Network */
    PORT: z.coerce.number().int().positive().default(8080),
    GRAPHQL_PORT: z.coerce.number().int().positive().optional(),
    GRAPHQL_PLAYGROUND: z
        .enum(['enabled', 'disabled'])
        .default('enabled')
        .transform((v) => v === 'enabled'),

    /* Security */
    JWT_PUBLIC_KEY_PATH: z.string().optional(),
    JWT_PRIVATE_KEY_PATH: z.string().optional(),

    /* Redis */
    REDIS_HOST: z.string(),
    REDIS_PORT: z.coerce.number().int().positive().default(6379),
    REDIS_DB: z.coerce.number().int().nonnegative().default(0),
    REDIS_PASSWORD: z.string().optional(),

    /* Rate Limiting */
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000), // 1 minute
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(120),

    /* Logging */
    LOG_LEVEL: z
        .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
        .default('info'),

    /* Feature Flags */
    RESPONSE_CACHE_ENABLED: z
        .enum(['true', 'false'])
        .default('true')
        .transform((v) => v === 'true'),

    /* Versioning */
    API_DEFAULT_VERSION: z.string().regex(/^v\d+$/).default('v1'),
    API_VERSIONS_ENABLED: z
        .string()
        .regex(/^v\d+(,v\d+)*$/)
        .default('v1')
        .transform((v) => v.split(',')),

    /* Downstream Micro-services */
    TIMELINE_SERVICE_URL: z.string().url(),
    MEDIA_SERVICE_URL: z.string().url(),
    MESSAGING_SERVICE_URL: z.string().url(),
    NOTIFICATIONS_SERVICE_URL: z.string().url(),
    SOCIAL_GRAPH_SERVICE_URL: z.string().url(),
});

type Env = z.infer<typeof envSchema>;

/**************************************************************************************************
 * Typed Configuration Model
 **************************************************************************************************/

export interface Config {
    readonly env: Env['NODE_ENV'];
    readonly app: {
        port: number;
        graphqlPort: number;
        graphqlPlayground: boolean;
    };
    readonly security: {
        jwt: {
            publicKey?: string;
            privateKey?: string;
        };
    };
    readonly redis: {
        host: string;
        port: number;
        db: number;
        password?: string;
    };
    readonly rateLimiting: {
        windowMs: number;
        maxRequests: number;
    };
    readonly logging: {
        level: Env['LOG_LEVEL'];
    };
    readonly features: {
        responseCache: boolean;
    };
    readonly versioning: {
        defaultVersion: string;
        enabledVersions: string[];
    };
    readonly services: {
        timeline: string;
        media: string;
        messaging: string;
        notifications: string;
        socialGraph: string;
    };
}

/**************************************************************************************************
 * Build Config Singleton
 **************************************************************************************************/

let _config: Config | undefined;

/**
 * Returns a fully hydrated, immutable configuration object.
 * The result is memoized to prevent re-validation on subsequent calls.
 */
export function getConfig(): Config {
    if (_config) return _config;

    // 1. Validate process.env
    const parsed: Env = envSchema.parse(process.env);

    // 2. Load key files
    const publicKey = loadKeyFile(parsed.JWT_PUBLIC_KEY_PATH);
    const privateKey = loadKeyFile(parsed.JWT_PRIVATE_KEY_PATH);

    // 3. Assemble final config
    const assembled: Config = {
        env: parsed.NODE_ENV,
        app: {
            port: parsed.PORT,
            graphqlPort: parsed.GRAPHQL_PORT ?? parsed.PORT, // default to REST port
            graphqlPlayground:
                parsed.NODE_ENV === 'production' ? false : parsed.GRAPHQL_PLAYGROUND,
        },
        security: {
            jwt: {
                publicKey,
                privateKey,
            },
        },
        redis: {
            host: parsed.REDIS_HOST,
            port: parsed.REDIS_PORT,
            db: parsed.REDIS_DB,
            password: parsed.REDIS_PASSWORD,
        },
        rateLimiting: {
            windowMs: parsed.RATE_LIMIT_WINDOW_MS,
            maxRequests: parsed.RATE_LIMIT_MAX_REQUESTS,
        },
        logging: {
            level: parsed.LOG_LEVEL,
        },
        features: {
            responseCache: parsed.RESPONSE_CACHE_ENABLED,
        },
        versioning: {
            defaultVersion: parsed.API_DEFAULT_VERSION,
            enabledVersions: parsed.API_VERSIONS_ENABLED,
        },
        services: {
            timeline: parsed.TIMELINE_SERVICE_URL,
            media: parsed.MEDIA_SERVICE_URL,
            messaging: parsed.MESSAGING_SERVICE_URL,
            notifications: parsed.NOTIFICATIONS_SERVICE_URL,
            socialGraph: parsed.SOCIAL_GRAPH_SERVICE_URL,
        },
    };

    _config = Object.freeze(assembled);
    return _config;
}

// Immediately build and export a singleton for convenience
export const config: Config = getConfig();
```
