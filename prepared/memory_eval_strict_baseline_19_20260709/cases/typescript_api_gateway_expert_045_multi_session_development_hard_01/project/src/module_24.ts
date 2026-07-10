```typescript
/***************************************************************************************************
 * File:        src/module_24.ts
 * Project:     SocialPulse Gateway – API Gateway
 *
 * Description:
 * ------------
 * Version-Negotiation facilities shared by the REST & GraphQL entry-points.
 * This module exposes:
 *
 *  • Value Object ............... ApiVersion
 *  • Factory / Service .......... VersionNegotiationService
 *  • HTTP Middleware ............ versionNegotiationMiddleware (Express / Fastify compatible)
 *  • GraphQL Plugin ............. apolloVersionNegotiationPlugin (Apollo-Server)
 *
 * The implementation adheres to clean-architecture:
 *     - Domain layer .... ApiVersion
 *     - Application layer . VersionNegotiationService
 *     - Presentation layer  versionNegotiationMiddleware | apolloVersionNegotiationPlugin
 *
 * Rationale:
 * ----------
 *  Clients may request a specific API version via (highest precedence first):
 *     1. URL parameter      : /v{n}/posts
 *     2. Custom header      : X-SocialPulse-Version: {n}
 *     3. Accept header      : application/vnd.socialpulse.v{n}+json
 *
 *  The gateway defaults to LATEST if no explicit version is requested.
 *  Invalid or sunset versions trigger 400 or 426 responses respectively.
 ***************************************************************************************************/

import type { Request, Response, NextFunction } from 'express';
import pino from 'pino';
import { PluginDefinition } from 'apollo-server-core';
import { GraphQLRequestContext } from 'apollo-server-types';
import createError from 'http-errors';
import { z } from 'zod';

const logger = pino({ name: 'version-negotiator' });

/* -------------------------------------------------------------------------------------------------
 * Domain Layer ─ Value Object: ApiVersion
 * -----------------------------------------------------------------------------------------------*/

/**
 * Maintains canonical list of supported API versions.
 * NOTE: Latest version MUST always be the first member.
 */
export enum SupportedVersion {
  V3 = 3, // Latest production version
  V2 = 2,
  V1 = 1,
}

const SUPPORTED_VERSIONS = new Set<number>(
  Object.values(SupportedVersion).filter((v) => typeof v === 'number') as number[]
);

export class ApiVersion {
  readonly version: SupportedVersion;

  private constructor(v: SupportedVersion) {
    this.version = v;
  }

  /** Factory: creates an ApiVersion from a raw number */
  public static of(v: number): ApiVersion {
    if (!SUPPORTED_VERSIONS.has(v)) {
      throw createError(
        400,
        `Unsupported API version '${v}'. Supported versions: ${[...SUPPORTED_VERSIONS].join(', ')}`
      );
    }
    return new ApiVersion(v as SupportedVersion);
  }

  /** Returns the latest version (first enum member) */
  public static latest(): ApiVersion {
    return new ApiVersion(SupportedVersion.V3);
  }

  /** Whether the current version is sunset (i.e., no longer served) */
  public isSunset(): boolean {
    // Business rule: Only V1 is considered sunset for demonstration.
    return this.version === SupportedVersion.V1;
  }

  public toString(): string {
    return `v${this.version}`;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Application Layer ─ VersionNegotiationService
 * -----------------------------------------------------------------------------------------------*/

export interface VersionSourceResult {
  version: ApiVersion;
  source:
    | 'url'
    | 'custom-header'
    | 'accept-header'
    | 'implicit-default'
    | 'unknown';
}

export class VersionNegotiationService {
  private readonly urlPattern = /^\/v(\d+)\//;

  /**
   * Determines API version for an incoming HTTP request.
   * Precedence order:
   *   1. URL (/v3/)
   *   2. Header: X-SocialPulse-Version
   *   3. Accept: application/vnd.socialpulse.v3+json
   *   4. Default (latest)
   *
   * Throws: 400 for unsupported, 426 for sunset versions.
   */
  public negotiate(req: Request): VersionSourceResult {
    const match = this.urlPattern.exec(req.path);
    if (match) {
      return this.validateAndReturn(match[1], 'url');
    }

    const header = req.header('X-SocialPulse-Version');
    if (header) {
      return this.validateAndReturn(header, 'custom-header');
    }

    const accept = req.header('Accept') ?? '';
    const acceptMatch = /vnd\.socialpulse\.v(\d+)/.exec(accept);
    if (acceptMatch) {
      return this.validateAndReturn(acceptMatch[1], 'accept-header');
    }

    // Implicit default
    const version = ApiVersion.latest();
    this.ensureNotSunset(version);
    return { version, source: 'implicit-default' };
  }

  private validateAndReturn(raw: string, source: VersionSourceResult['source']): VersionSourceResult {
    const parseSchema = z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .refine((n) => SUPPORTED_VERSIONS.has(n), {
        message: `Unsupported API version '${raw}'.`,
      });

    const parsed = parseSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ raw, error: parsed.error }, 'Failed to parse API version');
      throw createError(400, parsed.error.errors[0]?.message ?? 'Invalid API version');
    }

    const version = ApiVersion.of(parsed.data);
    this.ensureNotSunset(version);
    return { version, source };
  }

  private ensureNotSunset(version: ApiVersion): void {
    if (version.isSunset()) {
      throw createError(
        426,
        `API version ${version} is no longer supported. Please upgrade to ${ApiVersion.latest()}.`
      );
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * Presentation Layer ─ HTTP Middleware (Express / Fastify compatible)
 * -----------------------------------------------------------------------------------------------*/

/**
 * Augments request with negotiated version (req.apiVersion),
 * then continues pipeline. Attaches version info to response
 * headers for client visibility.
 */
export const versionNegotiationMiddleware =
  (service = new VersionNegotiationService()) =>
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const result = service.negotiate(req);
      // Expose on request object for downstream controllers
      (req as unknown as { apiVersion: ApiVersion }).apiVersion = result.version;

      // Echo negotiated version back to the client
      res.setHeader('X-SocialPulse-Negotiated-Version', result.version.toString());

      logger.debug(
        { path: req.path, source: result.source, version: result.version.toString() },
        'API version negotiated'
      );

      next();
    } catch (err) {
      next(err);
    }
  };

/* -------------------------------------------------------------------------------------------------
 * Presentation Layer ─ GraphQL Plugin (Apollo)
 * -----------------------------------------------------------------------------------------------*/

/**
 * Apollo plugin that populates `context.apiVersion`
 */
export const apolloVersionNegotiationPlugin =
  (service = new VersionNegotiationService()): PluginDefinition => ({
    async requestDidStart() {
      return {
        async didResolveOperation(requestContext: GraphQLRequestContext) {
          try {
            // Apollo request's `req` is an IncomingMessage
            const httpReq = requestContext.request.http!;
            // Convert IncomingMessage to partial Express Request signature
            const fauxReq = {
              path: httpReq.url || '/',
              header: (name: string) => httpReq.headers[name.toLowerCase()] as string | undefined,
            } as unknown as Request;

            const result = service.negotiate(fauxReq);

            requestContext.context.apiVersion = result.version;

            // Also include in response headers
            requestContext.response.http?.headers.set(
              'X-SocialPulse-Negotiated-Version',
              result.version.toString()
            );

            logger.debug(
              {
                operationName: requestContext.operationName,
                version: result.version.toString(),
                source: result.source,
              },
              'GraphQL API version negotiated'
            );
          } catch (err) {
            // Bubble up GraphQL formatted error
            throw err;
          }
        },
      };
    },
  });

/* -------------------------------------------------------------------------------------------------
 * Module Augmentation ─ Express Request typing
 * -----------------------------------------------------------------------------------------------*/

declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    interface Request {
      /** Resolved API version for the request (injected by middleware) */
      apiVersion?: ApiVersion;
    }
  }
}
```
