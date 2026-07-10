```cpp
// chrono_flow_nexus/src/domain/model/user.cpp
//
//  Copyright (c) ChronoFlow.
//  SPDX-License-Identifier: BUSL-1.1
//
//  NOTE: This is a domain-layer entity implementation.  No infrastructure
//  dependencies (SQL drivers, HTTP clients, etc.) should leak in here.
//

#include "domain/model/user.hpp"

#include <boost/uuid/random_generator.hpp>
#include <boost/uuid/uuid_io.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <iomanip>
#include <regex>
#include <sstream>
#include <stdexcept>

namespace chrono_flow::domain::model
{
using json = nlohmann::json;

/*─────────────────────────────────────────────────────────────────────────────
 * Utility helpers (anonymous namespace)
 *───────────────────────────────────────────────────────────────────────────*/
namespace
{
/*  Extracted email validator (RFC 5322 simplified).  Intentionally kept
 *  private to the TU; exposes no symbol to the outside world. */
bool is_valid_email(std::string_view candidate)
{
    // clang-format off
    static const std::regex pattern(
        R"(^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+)"
        R"(@([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$))",
        std::regex::optimize);
    // clang-format on
    return std::regex_match(candidate.data(), pattern);
}

/*  RFC 3339 formatter for std::chrono::system_clock::time_point */
std::string to_rfc3339(const std::chrono::system_clock::time_point& tp)
{
    using namespace std::chrono;

    auto ts     = system_clock::to_time_t(tp);
    auto subsecs = duration_cast<milliseconds>(tp.time_since_epoch()).count() %
                   1000;

    std::ostringstream oss;
#if defined(_MSC_VER)
    tm tm {};
    gmtime_s(&tm, &ts);
#else
    tm tm {};
    gmtime_r(&ts, &tm);
#endif
    oss << std::put_time(&tm, "%FT%T") << '.'
        << std::setw(3) << std::setfill('0') << subsecs << "Z";
    return oss.str();
}
} // namespace

/*─────────────────────────────────────────────────────────────────────────────
 * User factory
 *───────────────────────────────────────────────────────────────────────────*/
User User::create(std::string full_name,
                  std::string email_address,
                  std::vector<Role> initial_roles)
{
    if (full_name.empty())
    {
        throw std::invalid_argument("User full name cannot be empty");
    }
    if (!is_valid_email(email_address))
    {
        throw std::invalid_argument("Invalid e-mail address: " + email_address);
    }

    User u;
    u.id_          = boost::uuids::random_generator()();
    u.name_        = std::move(full_name);
    u.email_       = std::move(email_address);
    u.roles_       = std::move(initial_roles);
    u.created_at_  = std::chrono::system_clock::now();
    u.last_update_ = u.created_at_;

    return u;
}

/*─────────────────────────────────────────────────────────────────────────────
 * Mutating operations
 *───────────────────────────────────────────────────────────────────────────*/
void User::update_name(std::string new_name)
{
    if (new_name.empty())
    {
        throw std::invalid_argument("User name cannot be empty");
    }

    if (name_ == new_name) { return; } // noop

    name_        = std::move(new_name);
    touch();
}

void User::update_email(std::string new_email)
{
    if (!is_valid_email(new_email))
    {
        throw std::invalid_argument("Invalid e-mail address: " + new_email);
    }

    if (email_ == new_email) { return; }

    email_       = std::move(new_email);
    touch();
}

bool User::add_role(Role r)
{
    if (std::find(roles_.begin(), roles_.end(), r) != roles_.end())
    {
        return false; // already present
    }
    roles_.push_back(r);
    touch();
    return true;
}

bool User::remove_role(Role r)
{
    const auto it = std::remove(roles_.begin(), roles_.end(), r);
    if (it == roles_.end()) { return false; }

    roles_.erase(it, roles_.end());
    touch();
    return true;
}

/*─────────────────────────────────────────────────────────────────────────────
 * Query helpers
 *───────────────────────────────────────────────────────────────────────────*/
bool User::has_role(Role r) const
{
    return std::find(roles_.cbegin(), roles_.cend(), r) != roles_.cend();
}

/*─────────────────────────────────────────────────────────────────────────────
 * Equality / ordering
 *───────────────────────────────────────────────────────────────────────────*/
bool User::operator==(const User& other) const noexcept
{
    return id_ == other.id_;
}
bool User::operator!=(const User& other) const noexcept
{
    return !(*this == other);
}

/*─────────────────────────────────────────────────────────────────────────────
 * Serialization helpers
 *───────────────────────────────────────────────────────────────────────────*/
json User::to_json() const
{
    json j;
    j["id"]          = boost::uuids::to_string(id_);
    j["fullName"]    = name_;
    j["email"]       = email_;
    j["roles"]       = roles_;
    j["createdAt"]   = to_rfc3339(created_at_);
    j["lastUpdated"] = to_rfc3339(last_update_);
    return j;
}

/*  (static) json → User */
User User::from_json(const json& j)
{
    // Basic structural validation. Domain-layer: intentionally lenient
    // (thorough validation expected in DTO / transport layer).
    if (!j.contains("id") || !j.contains("fullName") || !j.contains("email"))
    {
        throw std::invalid_argument("User JSON missing mandatory fields");
    }

    User u;
    u.id_   = boost::lexical_cast<boost::uuids::uuid>(j.at("id").get<std::string>());
    u.name_ = j.at("fullName").get<std::string>();
    u.email_ = j.at("email").get<std::string>();

    if (j.contains("roles"))
    {
        u.roles_ = j.at("roles").get<std::vector<Role>>();
    }
    else
    {
        u.roles_ = {};
    }

    if (j.contains("createdAt"))
    {
        // Parsing of RFC 3339 omitted – non-critical for persistence.
        // For now we set created_at_ to current time.
        u.created_at_ = std::chrono::system_clock::now();
    }

    u.last_update_ = std::chrono::system_clock::now();
    return u;
}

/*─────────────────────────────────────────────────────────────────────────────
 * Private helpers
 *───────────────────────────────────────────────────────────────────────────*/
void User::touch() noexcept
{
    last_update_ = std::chrono::system_clock::now();
}

} // namespace chrono_flow::domain::model
```