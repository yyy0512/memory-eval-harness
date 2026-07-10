#include "UserType.h"

#include <api/v1/graphql/context/RequestContext.h>
#include <api/v1/graphql/scalars/DateTimeScalar.h>
#include <core/domain/User.h>
#include <core/services/UserService.h>
#include <utils/Uuid.h>

#include <graphqlservice/GraphQLService.h>
#include <spdlog/spdlog.h>

#include <chrono>
#include <future>
#include <utility>

namespace paletteflux::api::v1::graphql::types
{

using namespace ::graphql::service;
using ::paletteflux::utils::Uuid;

/*
 * Internal helpers
 * ====================================================================================
 */

/**
 * Helper that transforms an empty string into std::nullopt.  This is convenient for
 * optional string fields such as `avatarUrl` where an empty value in the underlying
 * model should be treated as “null” in the GraphQL response.
 */
[[nodiscard]]
static std::optional<std::string> toOptional(std::string value)
{
    if (value.empty())
    {
        return std::nullopt;
    }
    return value;
}

/*
 * UserType implementation
 * ====================================================================================
 */

UserType::UserType(std::shared_ptr<services::UserService> userService)
    : Object(
          { "Node", "User" }, /* ← Implements the GraphQL `Node` interface. */
          {
              /* Field map -------------------------------------------------------------------- */
              { "id",          [this](ResolverParams params) { return resolveId(std::move(params));         } },
              { "username",    [this](ResolverParams params) { return resolveUsername(std::move(params));   } },
              { "displayName", [this](ResolverParams params) { return resolveDisplayName(std::move(params));} },
              { "avatarUrl",   [this](ResolverParams params) { return resolveAvatarUrl(std::move(params));  } },
              { "roles",       [this](ResolverParams params) { return resolveRoles(std::move(params));      } },
              { "createdAt",   [this](ResolverParams params) { return resolveCreatedAt(std::move(params));  } },
              { "updatedAt",   [this](ResolverParams params) { return resolveUpdatedAt(std::move(params));  } },
          })
    , _userService(std::move(userService))
{
    if (!_userService)
    {
        throw std::invalid_argument(
            "UserType requires a non-null UserService instance (dependency-injected).");
    }
}

void UserType::setUserModel(std::shared_ptr<const domain::User> user) noexcept
{
    _userModel = std::move(user);
}

FieldResult<std::string> UserType::resolveId(ResolverParams&& /*params*/) const
{
    if (!_userModel)
    {
        return FieldResult<std::string>::createError("User model not initialised.");
    }
    return _userModel->id().toString();
}

FieldResult<std::string> UserType::resolveUsername(ResolverParams&& /*params*/) const
{
    if (!_userModel)
    {
        return FieldResult<std::string>::createError("User model not initialised.");
    }
    return _userModel->username();
}

FieldResult<std::string> UserType::resolveDisplayName(ResolverParams&& /*params*/) const
{
    if (!_userModel)
    {
        return FieldResult<std::string>::createError("User model not initialised.");
    }
    return _userModel->displayName();
}

FieldResult<std::optional<std::string>> UserType::resolveAvatarUrl(ResolverParams&& /*params*/) const
{
    if (!_userModel)
    {
        return FieldResult<std::optional<std::string>>::createError("User model not initialised.");
    }
    return toOptional(_userModel->avatarUrl());
}

FieldResult<std::vector<std::string>> UserType::resolveRoles(ResolverParams&& /*params*/) const
{
    if (!_userModel)
    {
        return FieldResult<std::vector<std::string>>::createError("User model not initialised.");
    }
    return _userModel->roles();
}

FieldResult<std::chrono::system_clock::time_point> UserType::resolveCreatedAt(
    ResolverParams&& /*params*/) const
{
    if (!_userModel)
    {
        return FieldResult<std::chrono::system_clock::time_point>::createError(
            "User model not initialised.");
    }
    return _userModel->createdAt();
}

FieldResult<std::chrono::system_clock::time_point> UserType::resolveUpdatedAt(
    ResolverParams&& /*params*/) const
{
    if (!_userModel)
    {
        return FieldResult<std::chrono::system_clock::time_point>::createError(
            "User model not initialised.");
    }
    return _userModel->updatedAt();
}

/*
 * Static factory helpers
 * ====================================================================================
 */

std::shared_ptr<UserType> UserType::fromId(
    const Uuid&                                            id,
    const std::shared_ptr<services::UserService>&          userService,
    const std::shared_ptr<context::RequestContext>&        requestContext)
{
    auto gqlObject = std::make_shared<UserType>(userService);

    try
    {
        gqlObject->_userModel = userService->getById(id, requestContext->authToken());
    }
    catch (const services::UserService::NotFoundError& ex)
    {
        spdlog::warn("User lookup failed for id “{}”: {}", id, ex.what());
        return nullptr; // Will propagate “null” to GraphQL client.
    }
    catch (const std::exception& ex)
    {
        spdlog::error("Unexpected error while loading user “{}”: {}", id, ex.what());
        throw; // Let higher-level middleware map this to a GraphQL error.
    }

    return gqlObject;
}

std::shared_ptr<UserType> UserType::fromModel(
    std::shared_ptr<const domain::User>          user,
    std::shared_ptr<services::UserService>       userService)
{
    auto gqlObject  = std::make_shared<UserType>(std::move(userService));
    gqlObject->_userModel = std::move(user);
    return gqlObject;
}

} // namespace paletteflux::api::v1::graphql::types