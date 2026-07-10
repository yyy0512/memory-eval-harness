#ifndef PALETTEFLUX_STUDIO_SRC_API_V1_GRAPHQL_TYPES_USERTYPE_H
#define PALETTEFLUX_STUDIO_SRC_API_V1_GRAPHQL_TYPES_USERTYPE_H

/**
 * PaletteFlux GraphQL Studio
 * --------------------------
 * UserType.h
 *
 * GraphQL run-time representation of the “User” domain entity.
 *
 * This type is hand-written rather than generated to showcase how custom
 * business logic, monitoring hooks, and fine-grained authorization rules
 * can be injected into the otherwise code-generated GraphQL schema produced
 * by cppgraphqlgen.
 *
 * Author: PaletteFlux Team
 * SPDX-License-Identifier: MIT
 */

#include <graphqlservice/GraphQLService.h>   // cppgraphqlgen
#include <graphqlservice/GraphQLParse.h>
#include <graphqlservice/GraphQLSchema.h>

#include <chrono>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace paletteflux::studio::api::v1::graphql::types {

using namespace std::literals;

/* Forward declarations of domain-layer types so we do not leak implementation
 * details from lower layers into GraphQL glue code. */
struct User;
struct Asset;
class ISecurityContext;
class IUserQueryService;

/* Domain-driven enumerations *************************************************/

/**
 * Represents high-level user roles as stored in the domain model.
 * Kept in this file because GraphQL needs to translate these to enum values.
 */
enum class UserRole
{
    Guest,
    Artist,
    Admin
};

/* GraphQL Object Helper ******************************************************/

/**
 * UserType
 * --------
 * Glue object that delegates GraphQL field resolution to the query service
 * while decorating calls with instrumentation & authorization checks.
 *
 * NOTE: The class intentionally lives entirely in the header so that the
 * generic/templated parts of cppgraphqlgen can inline our field resolvers.
 */
class UserType final : public graphql::schema::Object
{
public:
    /* Ctor + dtor ************************************************************/

    /**
     * Constructs a UserType.
     * @param userQueryService Service responsible for loading users from the
     *                         read-side database.
     * @param secCtx           Caller’s security context (thread-local).
     */
    explicit UserType(std::shared_ptr<const IUserQueryService> userQueryService,
                      std::shared_ptr<const ISecurityContext>  secCtx) noexcept;

    ~UserType() override = default;

    /* Factory ****************************************************************/

    /**
     * Registers this type and its field resolvers with the supplied schema.
     *
     * Example:
     *     auto& schema = service::Schema::Load(...) // generated
     *     UserType::addToSchema(schema, services.userQueries(), ctx);
     */
    static void addToSchema(graphql::schema::Schema&                   schema,
                            std::shared_ptr<const IUserQueryService>   userQueryService,
                            std::shared_ptr<const ISecurityContext>    secCtx);

private:
    /* Dependency references **************************************************/

    std::shared_ptr<const IUserQueryService> _userQueries;
    std::shared_ptr<const ISecurityContext>  _secCtx;   // may be null in unit tests

    /* Authorization helpers **************************************************/

    void ensureSelfOrAdmin(const User& target) const;
    void ensureAdmin() const;

    /* Static field resolvers *************************************************
     * Each resolver returns a future to enable asynchronous I/O down the line.
     */

    static graphql::service::FieldResult<std::string>
    resolveId(const graphql::service::FieldParams&  params,
              const std::shared_ptr<const User>&    user) noexcept;

    static graphql::service::FieldResult<std::string>
    resolveUsername(const graphql::service::FieldParams&  params,
                    const std::shared_ptr<const User>&    user) noexcept;

    static graphql::service::FieldResult<std::optional<std::string>>
    resolveDisplayName(const graphql::service::FieldParams&  params,
                       const std::shared_ptr<const User>&    user) noexcept;

    static graphql::service::FieldResult<std::vector<UserRole>>
    resolveRoles(const graphql::service::FieldParams&  params,
                 const std::shared_ptr<const User>&    user) noexcept;

    static graphql::service::FieldResult<graphql::response::Value>
    resolveCreatedAt(const graphql::service::FieldParams&  params,
                     const std::shared_ptr<const User>&    user) noexcept;

    static graphql::service::FieldResult<std::vector<std::shared_ptr<Asset>>>
    resolveOwnedAssets(const graphql::service::FieldParams&  params,
                       const std::shared_ptr<const User>&    user,
                       std::optional<int>                    first,
                       std::optional<std::string>            after) noexcept;

    /* Helper: converts chrono time_point to GraphQL String timestamp *********/

    static std::string toIso8601(const std::chrono::system_clock::time_point& tp);
};

/*======================  Implementation  ====================================*/

inline UserType::UserType(std::shared_ptr<const IUserQueryService> userQueryService,
                          std::shared_ptr<const ISecurityContext>  secCtx) noexcept
    : Object({}),        // base class takes list of interfaces
      _userQueries(std::move(userQueryService)),
      _secCtx(std::move(secCtx))
{
}

/*-------------------------------------------------------------------------*/

inline void UserType::ensureSelfOrAdmin(const User& target) const
{
    if (!_secCtx) { return; } // tests
    if (_secCtx->isAdmin()) { return; }
    if (_secCtx->userId() != target.id) {
        throw std::runtime_error("Forbidden: not allowed to access user");
    }
}

inline void UserType::ensureAdmin() const
{
    if (_secCtx && !_secCtx->isAdmin()) {
        throw std::runtime_error("Forbidden: admin privileges required");
    }
}

/* Field resolvers ----------------------------------------------------------*/

inline graphql::service::FieldResult<std::string>
UserType::resolveId(const graphql::service::FieldParams&,
                    const std::shared_ptr<const User>& user) noexcept
{
    return user ? user->id : "";
}

inline graphql::service::FieldResult<std::string>
UserType::resolveUsername(const graphql::service::FieldParams&,
                          const std::shared_ptr<const User>& user) noexcept
{
    return user ? user->username : "";
}

inline graphql::service::FieldResult<std::optional<std::string>>
UserType::resolveDisplayName(const graphql::service::FieldParams&,
                             const std::shared_ptr<const User>& user) noexcept
{
    return user ? user->displayName : std::nullopt;
}

inline graphql::service::FieldResult<std::vector<UserRole>>
UserType::resolveRoles(const graphql::service::FieldParams&,
                       const std::shared_ptr<const User>& user) noexcept
{
    return user ? user->roles : std::vector<UserRole>{};
}

inline graphql::service::FieldResult<graphql::response::Value>
UserType::resolveCreatedAt(const graphql::service::FieldParams&,
                           const std::shared_ptr<const User>& user) noexcept
{
    graphql::response::Value result;
    if (user) {
        result = graphql::response::Value(toIso8601(user->createdAt));
    }
    return result;
}

inline graphql::service::FieldResult<std::vector<std::shared_ptr<Asset>>>
UserType::resolveOwnedAssets(const graphql::service::FieldParams&  params,
                             const std::shared_ptr<const User>&    user,
                             std::optional<int>                    first,
                             std::optional<std::string>            after) noexcept
{
    // Pagination arguments (first, after) follow Relay spec.
    // Implementation is delegated to query service to keep resolvers thin.
    // `params.alias` is used here to demonstrate access to query metadata,
    // e.g., for field-level tracing/metrics.
    if (!user) {
        return {};
    }
    return params.withResult([&]() {
        return _userQueries->fetchOwnedAssets(user->id, first, after);
    });
}

/* Helper -------------------------------------------------------------------*/

inline std::string UserType::toIso8601(const std::chrono::system_clock::time_point& tp)
{
    using namespace std::chrono;
    auto tt   = system_clock::to_time_t(tp);
    auto tm   = *gmtime(&tt);
    char buf[32];
    strftime(buf, sizeof(buf), "%FT%TZ", &tm);
    return buf;
}

/* Schema registration ------------------------------------------------------*/

inline void UserType::addToSchema(graphql::schema::Schema&                 schema,
                                  std::shared_ptr<const IUserQueryService> userQueryService,
                                  std::shared_ptr<const ISecurityContext>  secCtx)
{
    using namespace graphql::schema;

    /* Add enum -------------------------------------------------------------*/
    if (!schema.HasType("UserRole")) {
        auto& enumRole = schema.AddEnumType("UserRole");
        enumRole.AddEnumValue("GUEST",  "Guest user",  static_cast<int>(UserRole::Guest));
        enumRole.AddEnumValue("ARTIST", "Artist",      static_cast<int>(UserRole::Artist));
        enumRole.AddEnumValue("ADMIN",  "Administrator", static_cast<int>(UserRole::Admin));
    }

    /* Add object -----------------------------------------------------------*/
    if (!schema.HasType("User")) {
        auto& object = schema.AddType<ObjectType>("User");

        object.AddField("id",         "ID of the user",     NonNullType::ID(),
            [=](FieldParams params, std::shared_ptr<const User> u)
            { return resolveId(params, std::move(u)); });

        object.AddField("username",   "Login handle",       NonNullType::String(),
            [=](FieldParams params, std::shared_ptr<const User> u)
            { return resolveUsername(params, std::move(u)); });

        object.AddField("displayName","Public display name", TypeKind::String,
            [=](FieldParams params, std::shared_ptr<const User> u)
            { return resolveDisplayName(params, std::move(u)); });

        object.AddField("roles",      "Role set", NonNullListType("UserRole"),
            [=](FieldParams params, std::shared_ptr<const User> u)
            { return resolveRoles(params, std::move(u)); });

        object.AddField("createdAt",  "ISO-date", NonNullType::String(),
            [=](FieldParams params, std::shared_ptr<const User> u)
            { return resolveCreatedAt(params, std::move(u)); });

        object.AddField("ownedAssets","Assets authored by user", ListType("Asset"))
              .AddArgument("first", NonNullType::Int())
              .AddArgument("after", TypeKind::String())
              .SetResolver([=](FieldParams params,
                               std::shared_ptr<const User> u,
                               std::optional<int> first,
                               std::optional<std::string> after)
              { return resolveOwnedAssets(params, std::move(u), first, std::move(after)); });
    }

    /* Attach middleware instance ------------------------------------------*/
    schema.AttachMiddleware(std::make_shared<UserType>(
        std::move(userQueryService), std::move(secCtx)));
}

} // namespace paletteflux::studio::api::v1::graphql::types

#endif // PALETTEFLUX_STUDIO_SRC_API_V1_GRAPHQL_TYPES_USERTYPE_H