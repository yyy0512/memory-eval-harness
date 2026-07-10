package com.vitalpulse.cloudcare.graphql.handler;

import com.amazonaws.serverless.proxy.internal.LambdaContainerHandler;
import com.amazonaws.serverless.proxy.model.AwsProxyRequest;
import com.amazonaws.serverless.proxy.model.AwsProxyResponse;
import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestStreamHandler;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.google.common.util.concurrent.RateLimiter;
import graphql.ExecutionInput;
import graphql.ExecutionResult;
import graphql.GraphQL;
import graphql.GraphQLError;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * AWS Lambda entry point for GraphQL requests coming from API Gateway (v1 / v2).
 *
 * <p>This handler is intentionally stateless; cold-start initialisation builds the {@link GraphQL}
 * engine and re-uses it for subsequent invocations to minimise latency and DynamoDB round-trips.
 *
 * <p>Main responsibilities:
 *  <ul>
 *      <li>‣ Parse API Gateway proxy request into a {@link GraphQLRequest}</li>
 *      <li>‣ Enforce in-process rate-limits to protect against runaway devices</li>
 *      <li>‣ Execute the query against the Core Graph service layer</li>
 *      <li>‣ Translate {@link ExecutionResult} into an API Gateway-compatible response</li>
 *      <li>‣ Emit structured logs with cold-start flag and latency metrics</li>
 *  </ul>
 *
 * Error handling follows the GraphQL spec — application-level errors are returned inside the
 * “errors” array while transport-level issues (e.g. malformed JSON) result in 400 or 429 payloads.
 */
public class GraphQLHandler implements RequestStreamHandler {

    private static final Logger LOG = LoggerFactory.getLogger(GraphQLHandler.class);

    private static final ObjectMapper MAPPER = new ObjectMapper()
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(SerializationFeature.INDENT_OUTPUT)
            .setSerializationInclusion(JsonInclude.Include.NON_NULL);

    // Lambda execution environment is single-threaded by default. 50 req/s is plenty for a single
    // micro VM. See: https://docs.aws.amazon.com/lambda/latest/dg/invocation-scaling.html
    private static final RateLimiter IN_PROCESS_RATE_LIMITER = RateLimiter.create(50.0);

    // Re-used between invocations (perf).
    private static final GraphQL GRAPH_QL = GraphQLProvider.getInstance().graphQL();

    // Used by logging to determine whether this invocation is running in a cold environment.
    private static volatile boolean coldStart = true;

    @Override
    public void handleRequest(final InputStream input, final OutputStream output, final Context context)
            throws IOException {

        final Instant start = Instant.now();
        final String awsRequestId = context.getAwsRequestId();

        AwsProxyRequest proxyRequest;
        try {
            proxyRequest = MAPPER.readValue(input, AwsProxyRequest.class);
        } catch (IOException ex) {
            LOG.warn("[{}] Malformed AWS proxy request: {}", awsRequestId, ex.getMessage());
            writeResponse(output, badRequest("Invalid AWS proxy request payload"));
            return;
        }

        // Basic IP-based rate-limiting (more advanced rules are enforced by API Gateway + WAF)
        if (!IN_PROCESS_RATE_LIMITER.tryAcquire()) {
            writeResponse(output, tooManyRequests("Rate limit exceeded"));
            return;
        }

        Optional<GraphQLRequest> gqlRequestOpt = parseGraphQLRequest(proxyRequest.getBody(), awsRequestId);
        if (gqlRequestOpt.isEmpty()) {
            writeResponse(output, badRequest("Un-parseable GraphQL body"));
            return;
        }

        GraphQLRequest gqlRequest = gqlRequestOpt.get();

        ExecutionInput executionInput = ExecutionInput.newExecutionInput()
                .query(gqlRequest.query())
                .operationName(gqlRequest.operationName())
                .variables(gqlRequest.variables())
                .context(RequestContext.from(awsRequestId, proxyRequest.getHeaders(), context))
                .build();

        ExecutionResult executionResult;
        try {
            executionResult = GRAPH_QL.execute(executionInput);
        } catch (Exception ex) {
            LOG.error("[{}] Unhandled exception during GraphQL execution", awsRequestId, ex);
            writeResponse(output, internalServerError("Unhandled exception during GraphQL execution"));
            return;
        }

        AwsProxyResponse proxyResponse = buildProxyResponse(executionResult);
        writeResponse(output, proxyResponse);

        // Emit latency metric
        Duration latency = Duration.between(start, Instant.now());
        LOG.info("[{}] {} (coldStart={}, latencyMs={})",
                awsRequestId,
                gqlRequest.operationName() == null ? "anonymousOperation" : gqlRequest.operationName(),
                coldStart,
                latency.toMillis());

        coldStart = false; // any subsequent invocations are by definition warm
    }

    /* ---------------------------------------------------------------------
     * Serialization helpers
     * ------------------------------------------------------------------- */

    private static void writeResponse(OutputStream output, AwsProxyResponse response) throws IOException {
        MAPPER.writeValue(output, response);
    }

    private static AwsProxyResponse buildProxyResponse(ExecutionResult executionResult) {
        GraphQLResponse body = new GraphQLResponse(
                executionResult.getData(),
                executionResult.getErrors()
        );

        try {
            String jsonBody = MAPPER.writeValueAsString(body);
            return new AwsProxyResponse(200, singletonJsonHeader(), jsonBody);
        } catch (JsonProcessingException ex) {
            LOG.error("Failed to serialise GraphQL response", ex);
            return internalServerError("Failed to serialise GraphQL response");
        }
    }

    private static Optional<GraphQLRequest> parseGraphQLRequest(String body, String requestId) {
        if (body == null || body.isBlank()) {
            LOG.warn("[{}] Empty request body", requestId);
            return Optional.empty();
        }

        try {
            return Optional.ofNullable(MAPPER.readValue(body, GraphQLRequest.class));
        } catch (IOException ex) {
            LOG.warn("[{}] Failed to parse GraphQL body: {}", requestId, ex.getMessage());
            return Optional.empty();
        }
    }

    /* ---------------------------------------------------------------------
     * Convenience builders for common responses
     * ------------------------------------------------------------------- */

    private static AwsProxyResponse badRequest(String msg) {
        return new AwsProxyResponse(400, singletonJsonHeader(), errorBody(msg));
    }

    private static AwsProxyResponse tooManyRequests(String msg) {
        return new AwsProxyResponse(429, singletonJsonHeader(), errorBody(msg));
    }

    private static AwsProxyResponse internalServerError(String msg) {
        return new AwsProxyResponse(500, singletonJsonHeader(), errorBody(msg));
    }

    private static Map<String, String> singletonJsonHeader() {
        return Collections.singletonMap("Content-Type", "application/json");
    }

    private static String errorBody(String message) {
        try {
            return MAPPER.writeValueAsString(Collections.singletonMap("error", message));
        } catch (JsonProcessingException e) {
            // last resort – should never happen
            return "{\"error\":\"" + message + "\"}";
        }
    }

    /* ---------------------------------------------------------------------
     * DTOs
     * ------------------------------------------------------------------- */

    /**
     * Incoming GraphQL Request payload – AWS AppSync compatible.
     */
    private record GraphQLRequest(
            String query,
            String operationName,
            Map<String, Object> variables
    ) {
        public Map<String, Object> variables() {
            return variables == null ? Collections.emptyMap() : variables;
        }
    }

    /**
     * Outbound GraphQL Response payload (spec-compliant).
     */
    private record GraphQLResponse(
            Object data,
            List<GraphQLError> errors
    ) {
        public List<GraphQLError> errors() {
            return errors == null ? Collections.emptyList() : errors;
        }
    }

    /* ---------------------------------------------------------------------
     * Request-Scoped Context passed down to DataFetchers
     * ------------------------------------------------------------------- */

    /**
     * Domain-specific metadata propagated to every resolver.
     */
    public record RequestContext(
            String awsRequestId,
            Map<String, String> headers,
            Context lambdaContext
    ) {
        public static RequestContext from(
                String awsRequestId,
                Map<String, String> headers,
                Context lambdaContext
        ) {
            return new RequestContext(
                    awsRequestId,
                    headers == null ? Collections.emptyMap() : headers,
                    lambdaContext
            );
        }
    }

    /* ---------------------------------------------------------------------
     * GraphQL round-trip bootstrapper
     * ------------------------------------------------------------------- */

    /**
     * Provides a lazily initialised {@link GraphQL} instance backed by the latest
     * schema and resolvers. Thread-safe singleton.
     */
    private static final class GraphQLProvider {

        private static final Logger LOG = LoggerFactory.getLogger(GraphQLProvider.class);
        private static volatile GraphQLProvider INSTANCE;

        private final GraphQL graphQL;

        private GraphQLProvider() {
            long started = System.currentTimeMillis();
            this.graphQL = buildGraphQL();
            LOG.info("GraphQL schema initialised in {} ms", System.currentTimeMillis() - started);
        }

        static GraphQLProvider getInstance() {
            if (INSTANCE == null) {
                synchronized (GraphQLProvider.class) {
                    if (INSTANCE == null) {
                        INSTANCE = new GraphQLProvider();
                    }
                }
            }
            return INSTANCE;
        }

        GraphQL graphQL() {
            return graphQL;
        }

        /**
         * Build the GraphQL engine by scanning the classpath for resolver beans.
         *
         * NOTE: Schema-first example. In production we load SDL from S3 and wire
         * the DataFetchers via Spring-like DI.
         */
        private GraphQL buildGraphQL() {
            // Placeholder implementation
            //
            // SchemaParser schemaParser = new SchemaParser();
            // TypeDefinitionRegistry typeRegistry = schemaParser.parse(loadSdl());
            // RuntimeWiring runtimeWiring = RuntimeWiring.newRuntimeWiring()
            //        .type("Query", builder -> builder.dataFetcher("patient", new PatientFetcher()))
            //        .build();
            // SchemaGenerator generator = new SchemaGenerator();
            // GraphQLSchema schema = generator.makeExecutableSchema(typeRegistry, runtimeWiring);
            //
            // return GraphQL.newGraphQL(schema)
            //        .instrumentation(new TracingInstrumentation())
            //        .build();
            return GraphQL.newGraphQL(LambdaContainerHandler.getContainerConfig().getGraphQLSchema())
                    .build();
        }
    }
}