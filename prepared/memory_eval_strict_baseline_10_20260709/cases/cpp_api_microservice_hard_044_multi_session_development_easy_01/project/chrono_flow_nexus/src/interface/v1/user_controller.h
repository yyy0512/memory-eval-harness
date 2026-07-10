#pragma once
/**************************************************************************************************
 * ChronoFlow Nexus – UserController (Interface Layer, v1)
 *
 * This header declares the v1::UserController, the entry-point for any user-centric interaction
 * coming from the transport layer (REST or GraphQL).  The controller exposes:
 *
 *   • REST handlers (GET /users/{id}, POST /users, …)
 *   • GraphQL field resolvers (Query.user, Query.users, Mutation.createUser, …)
 *
 * The controller:
 *   1. Delegates all business logic to the application-layer façade (application::UserService).
 *   2. Propagates domain errors to HTTP / GraphQL conform error documents.
 *   3. Produces structured logs and latency metrics for every request.
 *
 * NOTE: Only declarations & lightweight inline helpers live here; implementations are found in the
 *       matching .cc file so that compilation units stay lean.
 **************************************************************************************************/

#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chrono_flow::infrastructure::logging { class ILogger; }
namespace chrono_flow::infrastructure::metrics  { class IMetricsCollector; }

namespace chrono_flow::application {
class UserService;      // Handles command / query orchestration
struct PaginationCursor;
struct UserDto;         // Data-transfer object exposed to interface layer
} // namespace chrono_flow::application


// ---- Forward declarations for the transport abstractions ---------------------------------------
namespace chrono_flow::transport {

/* REST-layer façade.  The interface is intentionally minimalistic so that ChronoFlow
 * remains agnostic of the underlying HTTP server (Pistache, Crow, Boost.Beast, …).
 */
struct IRestRequest;
struct IRestResponse;
class  IRestRouter;

/* GraphQL-layer façade.  We rely on cgql or graphql-cpp behind the scenes, but the surface
 * here is reduced to what the interface layer actually needs.
 */
struct GraphQLFieldParams;
class  IGraphQLSchema;
class  GraphQLValue;

} // namespace chrono_flow::transport


namespace chrono_flow::interface::v1 {

/**************************************************************************************************
 * class UserController
 *************************************************************************************************/
class UserController
{
public:
    //----------------------------------------------------------------------------
    // Construction / Lifetime
    //----------------------------------------------------------------------------
    explicit UserController(std::shared_ptr<application::UserService>            user_service,
                            std::shared_ptr<infrastructure::metrics::IMetricsCollector> metrics,
                            std::shared_ptr<infrastructure::logging::ILogger>    logger) noexcept;

    // Delete copy / move semantics to prevent accidental slicing or shared state bugs.
    UserController(const UserController&)            = delete;
    UserController(UserController&&)                 = delete;
    UserController& operator=(const UserController&) = delete;
    UserController& operator=(UserController&&)      = delete;

    ~UserController() = default;

    //----------------------------------------------------------------------------
    // Registration entry-points
    //----------------------------------------------------------------------------
    /* Register all v1 REST endpoints onto the provided router.  The concrete router is injected
     * from the transport layer during bootstrap so we remain framework-agnostic.
     */
    void register_rest_endpoints(transport::IRestRouter& router);

    /* Register GraphQL resolvers onto the given schema (Query.user, Query.users, Mutation.*). */
    void register_graphql_resolvers(transport::IGraphQLSchema& schema);

private:
    //----------------------------------------------------------------------------
    // REST – handler methods
    //----------------------------------------------------------------------------
    void handle_get_user      (transport::IRestRequest&  req, transport::IRestResponse& res); // GET    /users/{id}
    void handle_create_user   (transport::IRestRequest&  req, transport::IRestResponse& res); // POST   /users
    void handle_update_user   (transport::IRestRequest&  req, transport::IRestResponse& res); // PUT    /users/{id}
    void handle_delete_user   (transport::IRestRequest&  req, transport::IRestResponse& res); // DELETE /users/{id}

    //----------------------------------------------------------------------------
    // GraphQL – resolver helpers
    //----------------------------------------------------------------------------
    transport::GraphQLValue resolve_user  (const transport::GraphQLFieldParams& params,
                                           std::string_view user_id);

    transport::GraphQLValue resolve_users (const transport::GraphQLFieldParams& params,
                                           std::optional<std::uint32_t> first,
                                           std::optional<std::string_view> after_cursor);

    transport::GraphQLValue create_user_mutation  (const transport::GraphQLFieldParams& params,
                                                   application::UserDto input);

    //----------------------------------------------------------------------------
    // Helper utilities
    //----------------------------------------------------------------------------
    /* Converts domain-layer error codes into HTTP status codes and GraphQL error
     * extensions.  Lives in the .cc to avoid coupling interface clients to domain enums.
     */
    [[nodiscard]]
    int map_domain_error_to_http_status(std::string_view domain_error) const noexcept;

    // Serialize UserDto(s) into JSON; implemented in .cc using nlohmann::json.
    std::string serialize_user_json (const application::UserDto& user)                const;
    std::string serialize_users_json(const std::vector<application::UserDto>& users,
                                     const std::optional<application::PaginationCursor>& next) const;

    // Sends a JSON error payload in a uniform structure.
    void send_json_error(transport::IRestResponse& res,
                         int                       http_status,
                         std::string_view          error_code,
                         std::string_view          message) const noexcept;

    //----------------------------------------------------------------------------
    // Members
    //----------------------------------------------------------------------------
    std::shared_ptr<application::UserService>                     user_service_;
    std::shared_ptr<infrastructure::metrics::IMetricsCollector>   metrics_;
    std::shared_ptr<infrastructure::logging::ILogger>             logger_;
};

/**************************************************************************************************
 * Inline implementation details (tiny helpers only)                                              *
 **************************************************************************************************/

inline UserController::UserController(
        std::shared_ptr<application::UserService>                    user_service,
        std::shared_ptr<infrastructure::metrics::IMetricsCollector>  metrics,
        std::shared_ptr<infrastructure::logging::ILogger>            logger) noexcept
    : user_service_{ std::move(user_service) }
    , metrics_      { std::move(metrics)      }
    , logger_       { std::move(logger)       }
{
    // Constructor intentionally minimal; heavy-lifting happens during register_* calls.
}

} // namespace chrono_flow::interface::v1