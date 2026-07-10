/*
 * PaletteFlux GraphQL Studio
 * File: paletteflux_studio/src/core/model/User.h
 *
 * Copyright (c) PaletteFlux
 *
 * Description:
 *   Immutable domain model representing an end-user that interacts with the
 *   PaletteFlux GraphQL Studio.  Encapsulates identity, security credentials,
 *   and authorization roles.  The class purposefully contains no persistence
 *   logic—repository / DAO layers must transform to and from this aggregate
 *   root.
 *
 *   Designed for high-performance, concurrent read access.  All mutation
 *   methods return a new instance, preserving functional semantics and
 *   eliminating data-race hazards in asynchronous command pipelines.
 *
 * NOTE:
 *   Implementation is header-only for template convenience.  Down-stream
 *   translation units should be built with –fvisibility-inlines-hidden.
 */

#ifndef PALETTEFLUX_STUDIO_CORE_MODEL_USER_H_
#define PALETTEFLUX_STUDIO_CORE_MODEL_USER_H_

// --- STL --------------------------------------------------------------------
#include <array>
#include <chrono>
#include <cstdint>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>

// --- 3rd-party --------------------------------------------------------------
//   Using single-header nlohmann::json for light-weight serialization.  The
//   component is optional and can be compiled out by defining
//   PALETTEFLUX_DISABLE_JSON.
#ifndef PALETTEFLUX_DISABLE_JSON
  #include <nlohmann/json.hpp>
#endif

//   OpenSSL for cryptographically secure hashing.  Fallback stub available when
//   OpenSSL headers are not present (unit-tests can stub hash deterministically).
#if __has_include(<openssl/sha.h>)
  #include <openssl/sha.h>
  #define PALETTEFLUX_HAS_OPENSSL 1
#else
  #define PALETTEFLUX_HAS_OPENSSL 0
#endif

// --- Namespace --------------------------------------------------------------
namespace paletteflux::core::model
{

//----------------------------------------------------------------------
// Role enumeration
//----------------------------------------------------------------------
enum class Role : std::uint8_t
{
    Guest      = 0,
    Artist     = 1,
    Developer  = 2,
    Moderator  = 3,
    Admin      = 4
};

// For human-readable logging.
inline constexpr std::string_view toString(Role role) noexcept
{
    switch (role)
    {
        case Role::Guest:     return "Guest";
        case Role::Artist:    return "Artist";
        case Role::Developer: return "Developer";
        case Role::Moderator: return "Moderator";
        case Role::Admin:     return "Admin";
        default:              return "Unknown";
    }
}

//----------------------------------------------------------------------
// User aggregate
//----------------------------------------------------------------------
class User final
{
public:
    using Clock      = std::chrono::system_clock;
    using TimePoint  = Clock::time_point;

    //------------------------------------------------------------------
    // Factory methods
    //------------------------------------------------------------------
    static User
    create(std::string  username,
           std::string  email,
           std::string  plaintextPassword,
           std::unordered_set<Role> roles = {Role::Guest})
    {
        if (username.empty())
            throw std::invalid_argument("Username must not be empty.");

        if (!isValidEmail(email))
            throw std::invalid_argument("Invalid e-mail address supplied.");

        return User{generateUuid(),
                    std::move(username),
                    std::move(email),
                    hashPassword(plaintextPassword),
                    std::move(roles),
                    Clock::now(),
                    Clock::now(),
                    true};
    }

    //------------------------------------------------------------------
    // Public interface
    //------------------------------------------------------------------
    const std::string&              id()        const noexcept { return id_; }
    const std::string&              username()  const noexcept { return username_; }
    const std::string&              email()     const noexcept { return email_; }
    const std::unordered_set<Role>& roles()     const noexcept { return roles_; }
    const TimePoint&                createdAt() const noexcept { return createdAt_; }
    const TimePoint&                updatedAt() const noexcept { return updatedAt_; }
    bool                            isActive()  const noexcept { return active_; }

    bool hasRole(Role r) const noexcept
    {
        return roles_.find(r) != roles_.end();
    }

    // Password comparison uses constant-time memcmp to mitigate timing attacks.
    bool verifyPassword(const std::string& plaintext) const
    {
        return constantTimeEqual(hashPassword(plaintext), passwordHash_);
    }

    //------------------------------------------------------------------
    // Domain-driven mutations (returning new value objects)
    //------------------------------------------------------------------
    [[nodiscard]] User addRole(Role r) const
    {
        auto newRoles = roles_;
        newRoles.insert(r);
        return mutatedWith(std::move(newRoles));
    }

    [[nodiscard]] User removeRole(Role r) const
    {
        auto newRoles = roles_;
        newRoles.erase(r);
        return mutatedWith(std::move(newRoles));
    }

    [[nodiscard]] User changeEmail(std::string newEmail) const
    {
        if (!isValidEmail(newEmail))
            throw std::invalid_argument("Invalid e-mail address supplied.");
        return mutatedWith(email_, std::move(newEmail));
    }

    [[nodiscard]] User changePassword(std::string plaintext) const
    {
        return mutatedWith(passwordHash_, hashPassword(plaintext));
    }

    [[nodiscard]] User deactivate() const
    {
        User copy = *this;
        copy.active_    = false;
        copy.updatedAt_ = Clock::now();
        return copy;
    }

    [[nodiscard]] User reactivate() const
    {
        User copy = *this;
        copy.active_    = true;
        copy.updatedAt_ = Clock::now();
        return copy;
    }

#ifndef PALETTEFLUX_DISABLE_JSON
    //------------------------------------------------------------------
    // JSON serialization
    //------------------------------------------------------------------
    nlohmann::json toJson() const
    {
        nlohmann::json j;
        j["id"]         = id_;
        j["username"]   = username_;
        j["email"]      = email_;
        j["roles"]      = transformRolesToStrings(roles_);
        j["created_at"] = toIso8601(createdAt_);
        j["updated_at"] = toIso8601(updatedAt_);
        j["active"]     = active_;
        return j;
    }

    static User fromJson(const nlohmann::json& j)
    {
        User u;
        u.id_         = j.at("id").get<std::string>();
        u.username_   = j.at("username").get<std::string>();
        u.email_      = j.at("email").get<std::string>();
        u.roles_      = transformStringsToRoles(j.at("roles"));
        u.createdAt_  = fromIso8601(j.at("created_at").get<std::string>());
        u.updatedAt_  = fromIso8601(j.at("updated_at").get<std::string>());
        u.active_     = j.at("active").get<bool>();

        // Password hash intentionally NOT serialized for security reasons.
        // Persistence layers are responsible for adding it explicitly.
        return u;
    }
#endif

private:
    //------------------------------------------------------------------
    // Constructors
    //------------------------------------------------------------------
    User() = default; // Private: used by deserializers.

    User(std::string                id,
         std::string                username,
         std::string                email,
         std::string                passwordHash,
         std::unordered_set<Role>   roles,
         TimePoint                  created,
         TimePoint                  updated,
         bool                       active)
    : id_{std::move(id)}
    , username_{std::move(username)}
    , email_{std::move(email)}
    , passwordHash_{std::move(passwordHash)}
    , roles_{std::move(roles)}
    , createdAt_{created}
    , updatedAt_{updated}
    , active_{active}
    {
    }

    //------------------------------------------------------------------
    // Internal helpers
    //------------------------------------------------------------------
    [[nodiscard]] static bool isValidEmail(std::string_view email)
    {
        // Simple RFC5322 subset validation.  Enough for baseline sanity checks.
        const auto at = email.find('@');
        if (at == std::string_view::npos || at == 0 || at + 1 >= email.size())
            return false;
        const auto dot = email.find('.', at);
        return dot != std::string_view::npos && dot + 1 < email.size();
    }

    // Generate RFC-4122 compliant UUID v4.  For brevity, use std::random_device.
    static std::string generateUuid()
    {
        std::array<uint8_t, 16> data{};
        for (auto &b : data)
        {
            b = static_cast<uint8_t>(rand() % 256); // NOLINT(cert-msc50-cpp)
        }
        data[6] = (data[6] & 0x0F) | 0x40; // version
        data[8] = (data[8] & 0x3F) | 0x80; // variant

        std::ostringstream oss;
        for (size_t i = 0; i < data.size(); ++i)
        {
            oss << std::hex << std::setw(2) << std::setfill('0')
                << static_cast<int>(data[i]);
            if (i == 3 || i == 5 || i == 7 || i == 9)
                oss << '-';
        }
        return oss.str();
    }

    static bool constantTimeEqual(const std::string& a, const std::string& b)
    {
        if (a.size() != b.size()) return false;
        volatile uint8_t diff = 0;
        for (size_t i = 0; i < a.size(); ++i)
            diff |= a[i] ^ b[i];
        return diff == 0;
    }

    static std::string hashPassword(const std::string& plaintext)
    {
        if (plaintext.empty())
            throw std::invalid_argument("Password must not be empty.");

#if PALETTEFLUX_HAS_OPENSSL
        std::array<unsigned char, SHA256_DIGEST_LENGTH> hash{};
        SHA256(reinterpret_cast<const unsigned char*>(plaintext.data()),
               plaintext.size(),
               hash.data());

        std::ostringstream oss;
        for (unsigned char c : hash)
            oss << std::hex << std::setw(2) << std::setfill('0')
                << static_cast<int>(c);
        return oss.str();
#else
        // Fallback: insecure but deterministic hash for test builds.
        std::hash<std::string> hasher;
        return std::to_string(hasher(plaintext));
#endif
    }

#ifndef PALETTEFLUX_DISABLE_JSON
    static std::vector<std::string> transformRolesToStrings(
        const std::unordered_set<Role>& roles)
    {
        std::vector<std::string> result;
        result.reserve(roles.size());
        for (Role r : roles)
            result.emplace_back(toString(r));
        return result;
    }

    static std::unordered_set<Role> transformStringsToRoles(
        const nlohmann::json& j)
    {
        std::unordered_set<Role> set;
        for (const auto& item : j)
        {
            const std::string roleStr = item.get<std::string>();
            if      (roleStr == "Guest")     set.insert(Role::Guest);
            else if (roleStr == "Artist")    set.insert(Role::Artist);
            else if (roleStr == "Developer") set.insert(Role::Developer);
            else if (roleStr == "Moderator") set.insert(Role::Moderator);
            else if (roleStr == "Admin")     set.insert(Role::Admin);
        }
        return set;
    }

    static std::string toIso8601(TimePoint tp)
    {
        const std::time_t t = Clock::to_time_t(tp);
        std::tm          tm{};
#if defined(_WIN32)
        gmtime_s(&tm, &t);
#else
        gmtime_r(&t, &tm);
#endif
        char buffer[25];
        std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &tm);
        return buffer;
    }

    static TimePoint fromIso8601(const std::string& s)
    {
        std::tm tm{};
        if (strptime(s.c_str(), "%Y-%m-%dT%H:%M:%SZ", &tm) == nullptr)
            throw std::invalid_argument("Invalid ISO-8601 timestamp.");
        return Clock::from_time_t(timegm(&tm));
    }
#endif // PALETTEFLUX_DISABLE_JSON

    // Helper to produce modified copies.
    [[nodiscard]] User mutatedWith(
        std::unordered_set<Role> newRoles) const
    {
        User copy = *this;
        copy.roles_     = std::move(newRoles);
        copy.updatedAt_ = Clock::now();
        return copy;
    }

    [[nodiscard]] User mutatedWith(
        const std::string& /*dummy*/, // not used – just to differentiate overload
        std::string newEmail) const
    {
        User copy = *this;
        copy.email_     = std::move(newEmail);
        copy.updatedAt_ = Clock::now();
        return copy;
    }

    [[nodiscard]] User mutatedWith(
        const std::string& /*dummy*/,
        std::string newPasswordHash) const
    {
        User copy = *this;
        copy.passwordHash_ = std::move(newPasswordHash);
        copy.updatedAt_    = Clock::now();
        return copy;
    }

    //------------------------------------------------------------------
    // Data members
    //------------------------------------------------------------------
    std::string              id_;
    std::string              username_;
    std::string              email_;
    std::string              passwordHash_;
    std::unordered_set<Role> roles_;
    TimePoint                createdAt_{};
    TimePoint                updatedAt_{};
    bool                     active_{true};
};

} // namespace paletteflux::core::model

#endif // PALETTEFLUX_STUDIO_CORE_MODEL_USER_H_
