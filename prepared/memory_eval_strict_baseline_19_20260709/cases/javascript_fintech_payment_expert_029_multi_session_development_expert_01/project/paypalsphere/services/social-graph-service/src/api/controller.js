```javascript
/**
 * PayPalsphere – Social Graph Service
 * -----------------------------------
 * High-level REST/JSON controller exposing command/query endpoints that sit on top
 * of an internal CQRS + Event-Sourcing domain model. The controller:
 *   • validates & sanitises user input (express-validator)
 *   • authenticates/authorises using JWT + RBAC
 *   • dispatches Commands/Queries through a thin application layer (commandBus/queryBus)
 *   • records an Audit-Trail entry for every mutating request
 *   • short-circuits requests via riskGuard when fraud/abuse is detected
 *   • signs + encrypts response payloads before leaving service boundary
 *
 * NOTE: Pure controller only—core domain logic is delegated to buses/handlers.
 */

/* eslint consistent-return: 0, no-unused-vars: 0 */

const express                       = require('express');
const { body, param, validationResult } = require('express-validator');
const createError                   = require('http-errors');
const { v4: uuid }                  = require('uuid');

const authMiddleware                = require('../middleware/auth');
const riskGuard                     = require('../middleware/riskGuard');
const withAudit                     = require('../middleware/auditTrail');
const encryptResponse               = require('../middleware/encryptResponse');
const logger                        = require('../utils/logger');
const { commandBus }                = require('../cqrs/commandBus');
const { queryBus }                  = require('../cqrs/queryBus');

const router = express.Router();

/**
 * Utility: Async handler wrapper so we don’t repeat try/catch in every route.
 */
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Utility: Centralised validation failure handler
 */
const assertValid = req => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw createError(422, 'Validation failed', { details: errors.array() });
    }
};

/* -------------------------------------------------------
 * Routes – Write-side (Commands)
 * ----------------------------------------------------- */

/**
 * POST /circles
 * Create a new circle.
 */
router.post(
    '/circles',
    authMiddleware.requireAuth,
    riskGuard.assess('create_circle'),
    body('name').isString().trim().isLength({ min: 2, max: 64 }),
    body('visibility').isIn(['private', 'public']).optional(),
    asyncHandler(async (req, res) => {
        assertValid(req);

        const {
            name,
            visibility = 'private',
            metadata = {},
        } = req.body;
        const userId = req.user.id;
        const correlationId = req.headers['x-correlation-id'] || uuid();

        const command = {
            type          : 'CREATE_CIRCLE',
            aggregateName : 'Circle',
            payload       : { name, visibility, metadata, ownerId: userId },
            metadata      : { correlationId, userId },
        };

        await commandBus.dispatch(command);

        withAudit(req, { action: 'CREATE_CIRCLE', entity: name });

        res.status(201).json({ circleId: command.payload.id, correlationId });
    }),
);

/**
 * POST /circles/:circleId/members
 * Add a member to an existing circle.
 */
router.post(
    '/circles/:circleId/members',
    authMiddleware.requireAuth,
    riskGuard.assess('add_member'),
    param('circleId').isUUID(4),
    body('memberId').isUUID(4),
    body('role').optional().isIn(['viewer', 'editor', 'admin']),
    asyncHandler(async (req, res) => {
        assertValid(req);

        const { circleId } = req.params;
        const { memberId, role = 'viewer' } = req.body;
        const correlationId = uuid();

        await commandBus.dispatch({
            type          : 'ADD_MEMBER',
            aggregateName : 'Circle',
            aggregateId   : circleId,
            payload       : { memberId, role },
            metadata      : { correlationId, userId: req.user.id },
        });

        withAudit(req, { action: 'ADD_MEMBER', entity: circleId, target: memberId });
        res.status(202).json({ circleId, memberId, correlationId });
    }),
);

/**
 * DELETE /circles/:circleId/members/:memberId
 * Remove a member from a circle.
 */
router.delete(
    '/circles/:circleId/members/:memberId',
    authMiddleware.requireAuth,
    riskGuard.assess('remove_member'),
    param('circleId').isUUID(4),
    param('memberId').isUUID(4),
    asyncHandler(async (req, res) => {
        assertValid(req);

        const { circleId, memberId } = req.params;
        const correlationId = uuid();

        await commandBus.dispatch({
            type          : 'REMOVE_MEMBER',
            aggregateName : 'Circle',
            aggregateId   : circleId,
            payload       : { memberId },
            metadata      : { correlationId, userId: req.user.id },
        });

        withAudit(req, { action: 'REMOVE_MEMBER', entity: circleId, target: memberId });
        res.status(204).end();
    }),
);

/**
 * POST /users/:userId/follow
 * Follow/unfollow another user. Toggle behaviour inside command handler.
 */
router.post(
    '/users/:userId/follow',
    authMiddleware.requireAuth,
    riskGuard.assess('toggle_follow'),
    param('userId').isUUID(4),
    asyncHandler(async (req, res) => {
        assertValid(req);

        const { userId: targetUserId } = req.params;
        const correlationId = uuid();

        await commandBus.dispatch({
            type          : 'TOGGLE_FOLLOW',
            aggregateName : 'UserGraph',
            aggregateId   : req.user.id,
            payload       : { targetUserId },
            metadata      : { correlationId, userId: req.user.id },
        });

        withAudit(req, { action: 'TOGGLE_FOLLOW', target: targetUserId });
        res.status(202).json({ targetUserId, correlationId });
    }),
);

/* -------------------------------------------------------
 * Routes – Read-side (Queries)
 * ----------------------------------------------------- */

/**
 * GET /users/:userId/graph
 * Retrieve the social graph for a user.
 */
router.get(
    '/users/:userId/graph',
    authMiddleware.requireAuth,
    param('userId').isUUID(4),
    asyncHandler(async (req, res) => {
        assertValid(req);

        const { userId } = req.params;
        const graph = await queryBus.execute({
            type     : 'GET_SOCIAL_GRAPH',
            payload  : { userId },
            metadata : { requestedBy: req.user.id },
        });

        res.status(200).json(encryptResponse(graph)); // field-level encryption
    }),
);

/**
 * GET /circles/:circleId
 * Public/Public-with-token circle info.
 */
router.get(
    '/circles/:circleId',
    authMiddleware.optionalAuth, // allow non-authenticated; handler decides access
    param('circleId').isUUID(4),
    asyncHandler(async (req, res) => {
        assertValid(req);

        const { circleId } = req.params;
        const circle = await queryBus.execute({
            type     : 'GET_CIRCLE_DETAIL',
            payload  : { circleId, requester: req.user?.id },
        });

        if (!circle) throw createError(404, 'Circle not found');

        res.status(200).json(encryptResponse(circle));
    }),
);

/* -------------------------------------------------------
 * Global error handler (local to router)
 * ----------------------------------------------------- */

router.use((err, req, res, next) => {
    const isProd = process.env.NODE_ENV === 'production';

    logger.error({ err, path: req.path, user: req.user?.id });

    if (createError.isHttpError(err)) {
        return res.status(err.status).json({
            error: err.message,
            ...(isProd ? null : { stack: err.stack, details: err.details }),
        });
    }

    // Unknown error – 500
    res.status(500).json({
        error: 'Internal Server Error',
        ...(isProd ? null : { stack: err.stack }),
    });
});

/* -------------------------------------------------------
 * Module exports
 * ----------------------------------------------------- */
module.exports = router;
```