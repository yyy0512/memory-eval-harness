```javascript
/**
 * PayPalsphere – Social Graph Service
 * File: src/api/routes.js
 *
 * This file wires HTTP endpoints to the domain-level command/query services
 * responsible for manipulating the Social Graph bounded-context. The router
 * is intentionally thin, performing authentication, request validation, basic
 * rate-limiting and error translation while delegating all business logic to
 * the service layer (in line with the Clean/Hexagonal Architecture approach).
 */

import express from 'express';
import asyncHandler from 'express-async-handler';
import {
  body,
  param,
  query,
  validationResult,
} from 'express-validator';

import AuthMiddleware from '../middleware/auth.js';
import RateLimitMiddleware from '../middleware/rate-limit.js';
import CircleCommandService from '../services/circle-command-service.js';
import CircleQueryService from '../services/circle-query-service.js';
import FollowCommandService from '../services/follow-command-service.js';
import FollowQueryService from '../services/follow-query-service.js';

const router = express.Router();

/**
 * ------------------------------------------------------------
 * Utility helpers
 * ------------------------------------------------------------
 */

/**
 * Collects express-validator errors and throws a single ValidationError—
 * caught later by the global error-handler middleware.
 */
const requestValidator =
  validations =>
    asyncHandler(async (req, _res, next) => {
      await Promise.all(validations.map(validation => validation.run(req)));

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        const error = new Error('Request validation failed');
        error.name = 'ValidationError';
        error.statusCode = 400;
        error.details = errors.array({ onlyFirstError: true });
        throw error;
      }

      next();
    });

/**
 * Applies common middlewares:
 * 1. Auth verification (OAuth2/JWT).
 * 2. Adaptive rate limiting (protects against brute-force / abuse).
 */
router.use(AuthMiddleware);
router.use(RateLimitMiddleware({ windowMs: 60_000, max: 90 })); // 90 req/min

/**
 * ------------------------------------------------------------
 * Routes – Circle CRUD
 * ------------------------------------------------------------
 */

/**
 * Create a new social circle
 * POST /api/social/circles
 */
router.post(
  '/circles',
  requestValidator([
    body('name')
      .isString()
      .trim()
      .isLength({ min: 3, max: 64 })
      .withMessage('Circle name must be 3-64 chars'),
    body('description')
      .optional()
      .isString()
      .isLength({ max: 256 })
      .withMessage('Description too long'),
    body('visibility')
      .isIn(['private', 'public', 'unlisted'])
      .withMessage('Invalid visibility mode'),
    body('members')
      .optional()
      .isArray({ max: 50 })
      .withMessage('Members must be an array with ≤50 userIds'),
    body('members.*')
      .isUUID()
      .withMessage('Member userIds must be valid UUIDs'),
  ]),
  asyncHandler(async (req, res) => {
    const { id: requesterId } = req.user; // populated by AuthMiddleware
    const {
      name,
      description = '',
      visibility,
      members = [],
    } = req.body;

    const circleId = await CircleCommandService.createCircle({
      ownerId: requesterId,
      name,
      description,
      visibility,
      initialMembers: members,
      sourceIp: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.status(201).json({ circleId });
  }),
);

/**
 * Add or remove members in bulk
 * PATCH /api/social/circles/:circleId/members
 */
router.patch(
  '/circles/:circleId/members',
  requestValidator([
    param('circleId').isUUID().withMessage('Invalid circleId'),
    body('action')
      .isIn(['add', 'remove'])
      .withMessage('Action must be add|remove'),
    body('memberIds')
      .isArray({ min: 1, max: 50 })
      .withMessage('memberIds must be 1–50 UUIDs'),
    body('memberIds.*').isUUID().withMessage('Invalid member UUID'),
  ]),
  asyncHandler(async (req, res) => {
    const { circleId } = req.params;
    const { action, memberIds } = req.body;
    const { id: actorId } = req.user;

    if (action === 'add') {
      await CircleCommandService.addMembers({
        circleId,
        actorId,
        memberIds,
      });
    } else {
      await CircleCommandService.removeMembers({
        circleId,
        actorId,
        memberIds,
      });
    }

    res.status(204).send();
  }),
);

/**
 * Get paginated timeline/feed for a circle
 * GET /api/social/circles/:circleId/feed?cursor=...
 */
router.get(
  '/circles/:circleId/feed',
  requestValidator([
    param('circleId').isUUID().withMessage('Invalid circleId'),
    query('cursor')
      .optional()
      .isString()
      .withMessage('Cursor must be a string'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .toInt()
      .withMessage('Limit must be 1–100'),
  ]),
  asyncHandler(async (req, res) => {
    const { circleId } = req.params;
    const { cursor = null, limit = 30 } = req.query;
    const { id: requesterId } = req.user;

    const { items, nextCursor } =
      await CircleQueryService.getCircleFeed({
        circleId,
        requesterId,
        cursor,
        limit,
      });

    res.json({ items, nextCursor });
  }),
);

/**
 * ------------------------------------------------------------
 * Routes – Follow System
 * ------------------------------------------------------------
 */

/**
 * Follow a user
 * POST /api/social/follow/:targetUserId
 */
router.post(
  '/follow/:targetUserId',
  requestValidator([
    param('targetUserId').isUUID().withMessage('Invalid targetUserId'),
  ]),
  asyncHandler(async (req, res) => {
    const { id: followerId } = req.user;
    const { targetUserId } = req.params;

    if (followerId === targetUserId) {
      const err = new Error('Cannot follow yourself');
      err.statusCode = 400;
      throw err;
    }

    await FollowCommandService.follow({
      followerId,
      targetUserId,
    });

    res.status(204).send();
  }),
);

/**
 * Unfollow a user
 * DELETE /api/social/follow/:targetUserId
 */
router.delete(
  '/follow/:targetUserId',
  requestValidator([
    param('targetUserId').isUUID().withMessage('Invalid targetUserId'),
  ]),
  asyncHandler(async (req, res) => {
    const { id: followerId } = req.user;
    const { targetUserId } = req.params;

    await FollowCommandService.unfollow({
      followerId,
      targetUserId,
    });

    res.status(204).send();
  }),
);

/**
 * Fetch recommended users to follow ("People you may pay")
 * GET /api/social/suggestions?limit=...
 */
router.get(
  '/suggestions',
  requestValidator([
    query('limit')
      .optional()
      .isInt({ min: 1, max: 50 })
      .toInt()
      .withMessage('Limit must be 1–50'),
  ]),
  asyncHandler(async (req, res) => {
    const { id: userId } = req.user;
    const { limit = 20 } = req.query;

    const suggestions =
      await FollowQueryService.getFollowSuggestions({ userId, limit });

    res.json({ suggestions });
  }),
);

/**
 * ------------------------------------------------------------
 * Health Check (internal)
 * ------------------------------------------------------------
 */
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'social-graph' });
});

export default router;
```