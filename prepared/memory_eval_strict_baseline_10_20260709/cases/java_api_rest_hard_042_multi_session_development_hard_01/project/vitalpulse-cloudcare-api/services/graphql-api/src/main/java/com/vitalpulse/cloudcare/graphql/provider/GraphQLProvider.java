package com.vitalpulse.cloudcare.graphql.provider;

import graphql.ExecutionInput;
import graphql.GraphQL;
import graphql.execution.instrumentation.ChainedInstrumentation;
import graphql.execution.instrumentation.Instrumentation;
import graphql.execution.instrumentation.SimpleInstrumentation;
import graphql.execution.instrumentation.dataloader.DataLoaderDispatcherInstrumentation;
import graphql.execution.instrumentation.tracing.TracingInstrumentation;
import graphql.schema.DataFetcher;
import graphql.schema.GraphQLSchema;
import graphql.schema.idl.RuntimeWiring;
import graphql.schema.idl.SchemaGenerator;
import graphql.schema.idl.SchemaParser;
import graphql.schema.idl.TypeDefinitionRegistry;
import org.dataloader.DataLoader;
import org.dataloader.DataLoaderRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.Resource;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.CompletableFuture;

/**
 * GraphQLProvider bootstraps the graphql-java engine, loads the SDL files, wires
 * fetchers, and exposes a fully-configured {@link GraphQL} instance used by the
 * Lambda handler.
 *
 * <p>
 * The provider is initialized once per container cold-start and therefore must
 * be thread-safe. Data-loader registries are created for every request to
 * guarantee request-scoped caching as recommended by graphql-java.
 * </p>
 *
 * <pre>
 *                +----------------------------+
 * Lambda Event → |  GraphQLLambdaHandler      |  → returns JSON
 *                |      (uses this class)     |
 *                +----------------------------+
 * </pre>
 */
@Component
public class GraphQLProvider {

    private static final Logger LOG = LoggerFactory.getLogger(GraphQLProvider.class);

    /**
     * Path to the GraphQL SDL file that lives on the classpath (e.g.
     * src/main/resources/schema.graphqls). Spring will inject the resource.
     */
    @Value("classpath:schema.graphqls")
    private Resource schemaResource;

    private final PatientService patientService;
    private final MedicationOrderService medicationOrderService;

    private GraphQL graphQL;

    public GraphQLProvider(final PatientService patientService,
                           final MedicationOrderService medicationOrderService) {
        this.patientService = Objects.requireNonNull(patientService);
        this.medicationOrderService = Objects.requireNonNull(medicationOrderService);
    }

    /**
     * Initializes an executable schema and the GraphQL engine. Called once by
     * Spring after dependency injection is complete.
     */
    @PostConstruct
    public void init() {
        LOG.info("Bootstrapping GraphQL engine…");
        final String sdl = readSchema();
        final TypeDefinitionRegistry registry = new SchemaParser().parse(sdl);
        final RuntimeWiring wiring = buildRuntimeWiring();
        final GraphQLSchema schema = new SchemaGenerator().makeExecutableSchema(registry, wiring);

        final Instrumentation instrumentation =
                new ChainedInstrumentation(List.of(
                        new TracingInstrumentation(),                           // performance tracing
                        new DataLoaderDispatcherInstrumentation(),              // batching
                        new LoggingInstrumentation()                            // custom logging
                ));

        this.graphQL = GraphQL
                .newGraphQL(schema)
                .instrumentation(instrumentation)
                .defaultDataFetcherExceptionHandler(new VpDataFetcherExceptionHandler())
                .build();

        LOG.info("GraphQL engine initialized successfully");
    }

    /**
     * Returns the singleton {@link GraphQL} instance.
     */
    public GraphQL graphQL() {
        return graphQL;
    }

    /**
     * Creates an {@link ExecutionInput} with a request-scoped {@link DataLoaderRegistry}
     * that provides caching and batching for downstream fetchers.
     *
     * @param query          GraphQL query/mutation string
     * @param operationName  optional operation name
     * @param variables      variables map (may be null)
     * @param context        custom context object propagated to fetchers
     */
    public ExecutionInput newExecutionInput(String query,
                                            String operationName,
                                            Map<String, Object> variables,
                                            Object context) {

        final ExecutionInput.Builder builder = ExecutionInput.newExecutionInput()
                .query(query)
                .operationName(operationName)
                .variables(variables == null ? Collections.emptyMap() : variables)
                .context(context)
                .dataLoaderRegistry(newDataLoaderRegistry());

        return builder.build();
    }

    /* --------------------------------------------------------------------- */
    /* ------------------------  Internal helpers  ------------------------- */
    /* --------------------------------------------------------------------- */

    private RuntimeWiring buildRuntimeWiring() {
        return RuntimeWiring.newRuntimeWiring()
                .type("Query", builder -> builder
                        .dataFetcher("patientById", patientByIdFetcher())
                        .dataFetcher("medicationOrders", medicationOrdersFetcher()))
                // Additional Mutation/Sub-subscription wiring can be added here
                .build();
    }

    private DataFetcher<Patient> patientByIdFetcher() {
        return environment -> {
            final String patientId = environment.getArgument("id");
            if (patientId == null) {
                throw new IllegalArgumentException("Argument 'id' is required.");
            }
            return patientService.getPatientById(patientId);
        };
    }

    private DataFetcher<MedicationOrderConnection> medicationOrdersFetcher() {
        return environment -> {
            final String patientId = environment.getArgument("patientId");
            final Integer first = environment.getArgument("first");           // pagination
            final String after = environment.getArgument("after");            // cursor
            return medicationOrderService.getMedicationOrders(patientId, first, after);
        };
    }

    private DataLoaderRegistry newDataLoaderRegistry() {
        final DataLoaderRegistry registry = new DataLoaderRegistry();

        // Example batch loader that resolves patient information by IDs
        final DataLoader<String, Patient> patientLoader = DataLoader.newMappedDataLoader(
                ids -> CompletableFuture.supplyAsync(() -> patientService.getPatientsByIds(ids))
        );

        registry.register("patientLoader", patientLoader);
        return registry;
    }

    private String readSchema() {
        try (var in = schemaResource.getInputStream()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            LOG.error("Failed to read GraphQL schema from {}", schemaResource, e);
            throw new UncheckedIOException("Unable to read schema.graphqls", e);
        }
    }

    /* --------------------------------------------------------------------- */
    /* ---------------------------  Helpers  --------------------------------*/
    /* --------------------------------------------------------------------- */

    /**
     * Simple request logging instrumentation that records execution time and
     * propagates enriched error information to CloudWatch.
     */
    private static class LoggingInstrumentation extends SimpleInstrumentation {
        private static final Logger REQ_LOG = LoggerFactory.getLogger("GraphQL.Request");

        @Override
        public ExecutionInput instrumentExecutionInput(ExecutionInput executionInput,
                                                       InstrumentationState state) {
            REQ_LOG.info("GraphQL request: opName='{}', query='{}'",
                    executionInput.getOperationName(), safeQuery(executionInput.getQuery()));
            return executionInput;
        }

        private String safeQuery(String query) {
            return query == null ? "" : query.replaceAll("[\\n\\r]+", " ").trim();
        }
    }

    /**
     * Custom exception handler that converts internal exceptions into safe,
     * client-visible errors while logging full stack traces server-side.
     */
    private static class VpDataFetcherExceptionHandler
            extends graphql.execution.SimpleDataFetcherExceptionHandler {

        private static final Logger EX_LOG = LoggerFactory.getLogger("GraphQL.Errors");

        @Override
        protected void logException(Throwable exception) {
            EX_LOG.error("GraphQL data fetcher exception", exception);
        }
    }

    /* --------------------------------------------------------------------- */
    /* ----------------------  Domain placeholders  ------------------------ */
    /* --------------------------------------------------------------------- */
    /*  NOTE:
        The following domain classes and services are placeholders. They would
        live in their own packages/modules in the real project. They exist here
        solely to make this single file self-contained and compilable.          */

    public interface PatientService {
        Patient getPatientById(String id);

        Map<String, Patient> getPatientsByIds(List<String> ids);
    }

    public interface MedicationOrderService {
        MedicationOrderConnection getMedicationOrders(String patientId, Integer first, String after);
    }

    public static final class Patient {
        public final String id;
        public final String givenName;
        public final String familyName;

        public Patient(String id, String givenName, String familyName) {
            this.id = id;
            this.givenName = givenName;
            this.familyName = familyName;
        }
    }

    public static final class MedicationOrderConnection {
        public final List<MedicationOrder> nodes;
        public final PageInfo pageInfo;

        public MedicationOrderConnection(List<MedicationOrder> nodes, PageInfo pageInfo) {
            this.nodes = nodes;
            this.pageInfo = pageInfo;
        }
    }

    public static final class MedicationOrder {
        public final String id;
        public final String medicationCode;
        public final String status;

        public MedicationOrder(String id, String medicationCode, String status) {
            this.id = id;
            this.medicationCode = medicationCode;
            this.status = status;
        }
    }

    public static final class PageInfo {
        public final String endCursor;
        public final boolean hasNextPage;

        public PageInfo(String endCursor, boolean hasNextPage) {
            this.endCursor = endCursor;
            this.hasNextPage = hasNextPage;
        }
    }
}