"use strict";

/**
 * RTMP Controller
 * -----------------------------------------------------------------------------
 * Provides HTTP endpoints that mediate RTMP publish / play sessions entering the
 * StreamPulse Nexus ingress gateway.  The controller:
 *
 *  • Authenticates and authorizes RTMP clients via AuthService
 *  • Picks an optimal ingest node using the pluggable LoadBalancer strategy
 *  • Registers / tracks stream-lifecycle state inside the StreamRegistry
 *  • Emits high-level domain events onto the system-wide EventBus
 *  • Records operational metrics for dashboards & alert rules
 *  • Executes fallback Command objects when abnormal conditions are detected
 *
 *  This controller demonstrates use of the Strategy, Observer, Event-Driven and
 *  Command patterns that permeate the StreamPulse architecture.
 */

const express           = require("express");
const createError       = require("http-errors");

const { getLogger }     = require("../utils/logger");
const EventBus          = require("../event-bus");
const LoadBalancer      = require("../services/load-balancer");
const AuthService       = require("../services/auth.service");
const StreamRegistry    = require("../services/stream-registry");
const metrics           = require("../metrics/metrics.agent");
const { AbortStreamCommand } = require("../commands/abort-stream.command");

// -----------------------------------------------------------------------------
// Private constants
// -----------------------------------------------------------------------------
const router  = express.Router();
const log     = getLogger({ module: "rtmp.controller" });

/**
 * @typedef {Object} HandshakeRequestBody
 * @property {string} streamKey     - Secret stream key provided by producer
 * @property {string} protocol      - Protocol variant ("rtmp", "rtmps", etc.)
 * @property {string} ip            - Source IP address of the publisher
 * @property {Object} [meta]        - Additional metadata forwarded by client
 */

/**
 * @typedef {Object} HandshakeResponseBody
 * @property {string} streamId      - Internal, globally-unique stream ID
 * @property {string} ingestUrl     - RTMP URL that the client should push to
 * @property {number} ttl           - Seconds until the reservation expires
 * @property {number} createdAt     - UTC epoch when the reservation was made
 */

/**
 * Wraps async Express handlers so we can `throw` without try/catch noise.
 * @param {import("express").RequestHandler} fn
 * @returns {import("express").RequestHandler}
 */
const asyncHandler = (fn) => (req, res, next) => Promise
    .resolve(fn(req, res, next))
    .catch(next);

// -----------------------------------------------------------------------------
// Controller class
// -----------------------------------------------------------------------------
class RtmpController {

    /**
     * POST /api/rtmp/handshake
     * -----------------------
     * Creates a short-lived reservation (a “handshake ticket”) that tells the
     * publisher which ingest node to dial.  The handshake must complete within
     * the configured TTL or it is automatically reclaimed.
     *
     * Emits:
     *   • event: "STREAM_PENDING" (topic: streams.lifecycle)
     *
     * Metrics:
     *   • rtmp_handshake_total{status="success|failure"}
     *
     * @param {import("express").Request<{}, HandshakeResponseBody, HandshakeRequestBody>} req
     * @param {import("express").Response<HandshakeResponseBody>} res
     */
    async handleHandshake(req, res) {
        const now = Date.now();
        const { streamKey, protocol, ip, meta = {} } = this._sanitizeInput(req.body);

        // 1. Preconditions -----------------------------------------------------
        if (!streamKey || !protocol || !ip) {
            metrics.increment("rtmp_handshake_total", { status: "failure", reason: "invalid_payload" });
            throw createError.BadRequest("Missing required fields: streamKey, protocol, ip");
        }

        // 2. Authentication / Authorization -----------------------------------
        const producer = await AuthService.validateStreamKey(streamKey).catch((err) => {
            log.warn({ err, streamKey }, "Stream-key validation failed");
            metrics.increment("rtmp_handshake_total", { status: "failure", reason: "unauthorized" });
            throw createError.Unauthorized("Invalid stream key");
        });

        // 3. Choose an ingest node via pluggable load-balancer strategy -------
        const ingestNode = await LoadBalancer.pickNode({
            protocol,
            region : req.headers["x-region-hint"] || producer.preferredRegion,
        });
        if (!ingestNode) {
            metrics.increment("rtmp_handshake_total", { status: "failure", reason: "no_capacity" });
            throw createError.ServiceUnavailable("No ingest capacity available right now");
        }

        // 4. Register handshake / stream-id -----------------------------------
        const registration = await StreamRegistry.reserve({
            producerId   : producer.id,
            ingestNodeId : ingestNode.id,
            meta,
            ttl          : StreamRegistry.DEFAULT_TTL, // seconds
        });

        log.info(
            { streamId: registration.streamId, producerId: producer.id, ingestNode: ingestNode.name },
            "RTMP handshake reservation succeeded"
        );

        // 5. Emit domain event -------------------------------------------------
        EventBus.emit("streams.lifecycle", {
            type      : "STREAM_PENDING",
            timestamp : now,
            payload   : {
                streamId   : registration.streamId,
                producerId : producer.id,
                ingestNode : ingestNode.id,
            },
        });

        metrics.increment("rtmp_handshake_total", { status: "success" });

        // 6. Respond -----------------------------------------------------------
        /** @type {HandshakeResponseBody} */
        const responseBody = {
            streamId  : registration.streamId,
            ingestUrl : `${protocol}://${ingestNode.endpoint}/${registration.streamId}`,
            ttl       : registration.ttl,
            createdAt : registration.createdAt,
        };
        res.status(201).json(responseBody);
    }


    /**
     * DELETE /api/rtmp/:streamId
     * --------------------------
     * Aborts an active or pending RTMP stream.  The request can originate from:
     *   • A producer explicitly stopping their encoder
     *   • An internal watchdog triggered by StreamPulse monitoring
     *   • A moderator forcibly terminating a broadcast
     *
     * Executes AbortStreamCommand in accordance with the Command pattern.
     *
     * @param {import("express").Request<{streamId: string}>} req
     * @param {import("express").Response<void>} res
     */
    async handleAbortStream(req, res) {
        const { streamId } = req.params;

        if (!streamId) {
            throw createError.BadRequest("streamId is required");
        }

        const abortCmd = new AbortStreamCommand({ streamId, registry: StreamRegistry, eventBus: EventBus });

        // The command internally handles edge-cases (non-existent stream, etc.)
        await abortCmd.execute();

        metrics.increment("rtmp_abort_total");
        res.sendStatus(204);
    }

    /**
     * GET /api/rtmp/:streamId
     * -----------------------
     * Returns state information about a particular stream.
     *
     * @param {import("express").Request<{streamId: string}>} req
     * @param {import("express").Response<any>} res
     */
    async getStreamStatus(req, res) {
        const { streamId } = req.params;
        const info = await StreamRegistry.get(streamId);

        if (!info) {
            throw createError.NotFound("Stream not found");
        }

        res.json({
            streamId,
            state        : info.state,
            ingestNodeId : info.ingestNodeId,
            createdAt    : info.createdAt,
            updatedAt    : info.updatedAt,
        });
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * Sanitizes incoming untrusted payloads to mitigate injection / prototype
     * pollution attacks before further processing within the controller.
     *
     * @template T
     * @param {T} payload
     * @returns {T}
     */
    _sanitizeInput(payload) {
        if (payload && typeof payload === "object") {
            // Create a shallow copy stripping out forbidden keys
            const clean = {};
            for (const [key, value] of Object.entries(payload)) {
                if (!key.startsWith("$") && key !== "__proto__") {
                    clean[key] = value;
                }
            }
            // @ts-ignore
            return clean;
        }
        // @ts-ignore
        return {};
    }
}

// -----------------------------------------------------------------------------
// Route bindings
// -----------------------------------------------------------------------------
const controller = new RtmpController();

router.post("/handshake",  asyncHandler(controller.handleHandshake.bind(controller)));
router.delete("/:streamId", asyncHandler(controller.handleAbortStream.bind(controller)));
router.get("/:streamId",    asyncHandler(controller.getStreamStatus.bind(controller)));

module.exports = router;

// -----------------------------------------------------------------------------
// Centralized error middleware
// -----------------------------------------------------------------------------
/**
 * NOTE: Express apps consuming this router must ensure they have an error
 * handler added after all routers.  Example:
 *
 *   app.use("/api/rtmp", require("./controllers/rtmp.controller"));
 *
 *   app.use((err, _req, res, _next) => {
 *       const status = err.status || 500;
 *       res.status(status).json({
 *           error  : err.message,
 *           status : status,
 *       });
 *   });
 */