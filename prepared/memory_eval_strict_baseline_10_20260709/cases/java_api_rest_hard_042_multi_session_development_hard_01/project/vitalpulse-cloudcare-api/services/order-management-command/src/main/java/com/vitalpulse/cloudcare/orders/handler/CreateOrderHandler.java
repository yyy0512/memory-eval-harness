```java
package com.vitalpulse.cloudcare.orders.handler;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyRequestEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyResponseEvent;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vitalpulse.cloudcare.commons.validation.ValidationException;
import com.vitalpulse.cloudcare.commons.validation.RequestValidator;
import com.vitalpulse.cloudcare.orders.command.CreateOrderCommand;
import com.vitalpulse.cloudcare.orders.domain.Order;
import com.vitalpulse.cloudcare.orders.exception.DuplicateOrderException;
import com.vitalpulse.cloudcare.orders.service.OrderService;

import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * AWS Lambda handler that creates a new Order resource.
 *
 * <p>The handler is designed to be stateless and idempotent. It performs:
 *  <ul>
 *      <li>Rate-limiting on a per-IP basis</li>
 *      <li>JSON-schema validation of the request payload</li>
 *      <li>Creation of an {@link Order} through the {@link OrderService}</li>
 *      <li>Full error handling and mapping to well-defined HTTP status codes</li>
 *  </ul>
 *
 *  The Lambda expects an API Gateway (REST) proxy integration event and returns
 *  an equally shaped proxy response for maximum interoperability.
 */
public class CreateOrderHandler
        implements RequestHandler<APIGatewayProxyRequestEvent, APIGatewayProxyResponseEvent> {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper()
            .findAndRegisterModules()
            .setSerializationInclusion(JsonInclude.Include.NON_NULL);

    // ---- Dependencies -----------------------------------------------------

    private final OrderService        orderService;
    private final RequestValidator    requestValidator;
    private final IpRateLimiter       rateLimiter;

    // ---- Construction -----------------------------------------------------

    @SuppressWarnings("unused") // Called by AWS Lambda via default constructor
    public CreateOrderHandler() {
        /*
         * In production code you would wire these dependencies through a DI
         * framework such as Dagger/Spring or through the AWS Lambda Powertools
         * utility.  For brevity and clarity, they are created manually.
         */
        this.orderService     = OrderService.defaultInstance();
        this.requestValidator = RequestValidator.jsonSchema("/schemas/create-order.json");
        this.rateLimiter      = new IpRateLimiter(400, Duration.ofMinutes(1));
    }

    // ---- Request handling -------------------------------------------------

    @Override
    public APIGatewayProxyResponseEvent handleRequest(
            final APIGatewayProxyRequestEvent request,
            final Context context) {

        final var logger        = context.getLogger();
        final var correlationId = resolveCorrelationId(request);

        try {
            // 1. Rate-limit first to keep hostile traffic cheap.
            final String sourceIp = sourceIpOf(request);
            if (!rateLimiter.tryAcquire(sourceIp)) {
                return buildResponse(
                        429, errorBody("rate_limit_exceeded",
                                       "Too many requests, please retry later"),
                        correlationId);
            }

            // 2. Validate payload against JSON Schema.
            requestValidator.validate(request.getBody());

            // 3. Deserialize JSON → Command object.
            final CreateOrderCommand cmd =
                    OBJECT_MAPPER.readValue(request.getBody(), CreateOrderCommand.class);

            // 4. Execute use-case / business logic.
            final Order newOrder = orderService.createOrder(cmd, correlationId);

            // 5. Serialize domain object → JSON and return HTTP 201 Created.
            final String responseBody = OBJECT_MAPPER.writeValueAsString(newOrder);
            return buildResponse(201, responseBody, correlationId);

        } catch (ValidationException ve) {
            logger.log("Validation failed: " + ve.getMessage());
            return buildResponse(422, errorBody("validation_error", ve.getErrors()), correlationId);

        } catch (DuplicateOrderException de) {
            logger.log("Duplicate order detected: " + de.getMessage());
            return buildResponse(409, errorBody("duplicate_order", de.getMessage()), correlationId);

        } catch (JsonProcessingException jpe) { // includes IOExceptions from Jackson
            logger.log("Malformed JSON payload: " + jpe.getMessage());
            return buildResponse(400, errorBody("invalid_json", "Malformed request body"), correlationId);

        } catch (Exception ex) {
            logger.log("Unhandled exception: " + ex);
            return buildResponse(500, errorBody("internal_error", "Unexpected server error"), correlationId);
        }
    }

    // ---- Helper methods ---------------------------------------------------

    /**
     * Creates a sanitized, always-present correlation ID that is echoed in the
     * request logs and response headers.
     */
    private static String resolveCorrelationId(APIGatewayProxyRequestEvent request) {
        final String cidHeader =
                request.getHeaders() != null ? request.getHeaders().get("X-Correlation-Id") : null;
        return Objects.requireNonNullElseGet(cidHeader, UUID::randomUUID);
    }

    private static String sourceIpOf(APIGatewayProxyRequestEvent request) {
        try {
            return request.getRequestContext()
                          .getIdentity()
                          .getSourceIp();
        } catch (NullPointerException npe) {
            return "unknown"; // Should never happen with proper API GW settings
        }
    }

    /**
     * Builds an {@link APIGatewayProxyResponseEvent} with the default CloudCare
     * headers applied.
     */
    private static APIGatewayProxyResponseEvent buildResponse(
            final int status,
            final String body,
            final String correlationId) {

        return new APIGatewayProxyResponseEvent()
                .withStatusCode(status)
                .withHeaders(Map.of(
                        "Content-Type", "application/json",
                        "X-Correlation-Id", correlationId,
                        "Cache-Control", "no-store"))
                .withBody(body);
    }

    /**
     * Convenience to create CloudCare-style error envelopes.
     */
    private static String errorBody(final String code, final Object detail) {
        try {
            return OBJECT_MAPPER.writeValueAsString(Map.of(
                    "error", Map.of(
                            "code", code,
                            "detail", detail)));
        } catch (JsonProcessingException jpe) {
            // In the extremely rare case that JSON serialization breaks,
            // fall back to a plain-text message that will still reach the client.
            return "{\"error\":{\"code\":\"serialization_failure\",\"detail\":\"" +
                    jpe.getMessage() + "\"}}";
        }
    }

    // -----------------------------------------------------------------------
    //  Internal helper classes
    // -----------------------------------------------------------------------

    /**
     * Simple fixed-window IP-based rate limiter backed by an in-memory counter.
     *
     * <p>Because AWS Lambda may reuse execution environments between invocations,
     * this implementation provides an efficient yet isolated limiter that resets
     * after a configurable time window.  It is not a substitute for the primary
     * usage-plan throttling configured in API Gateway, but serves as an
     * application-level safeguard.</p>
     */
    static final class IpRateLimiter {

        private final int                       maxRequests;
        private final Duration                  window;
        private final ConcurrentHashMap<String, Counter> buckets = new ConcurrentHashMap<>();

        IpRateLimiter(final int maxRequests, final Duration window) {
            this.maxRequests = maxRequests;
            this.window      = window;
        }

        /**
         * Attempts to acquire a single permit for the given IP address.
         *
         * @return {@code true} if the request is permitted, {@code false} otherwise.
         */
        boolean tryAcquire(final String ip) {
            final Instant now = Instant.now();

            final Counter counter = buckets.compute(ip, (key, existing) -> {
                if (existing == null || existing.windowStart.plus(window).isBefore(now)) {
                    return new Counter(now, new AtomicInteger(1));
                }
                existing.count.incrementAndGet();
                return existing;
            });

            return counter.count.get() <= maxRequests;
        }

        private record Counter(Instant windowStart, AtomicInteger count) { }
    }
}
```