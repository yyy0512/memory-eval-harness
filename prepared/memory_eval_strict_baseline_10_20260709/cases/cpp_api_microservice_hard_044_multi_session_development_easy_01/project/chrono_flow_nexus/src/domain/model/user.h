#pragma once
/**
 *  chrono_flow_nexus/src/domain/model/user.h
 *
 *  Copyright (c) 2024 ChronoFlow
 *
 *  Licensed under the MIT License.  See LICENSE file in the project root
 *  for full license information.
 *
 *  Domain model: `User`
 *
 *  A User represents an individual account that interacts with ChronoFlow
 *  Nexus.  All domain-specific invariants are enforced in this class, and
 *  no public data members are exposed.  The type is *move-only* to avoid
 *  inadvertent data copies (e.g., large preference objects).  The model
 *  offers JSON (de)serialization helpers to streamline persistence and
 *  wire-format conversions in the infrastructure layer.
 */

#include <string>
#include <unordered_set>
#include <chrono>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <utility>

#include <boost/uuid/uuid.hpp>
#include <boost/uuid/uuid_generators.hpp>
#include <boost/uuid/uuid_io.hpp>

#include <nlohmann/json.hpp>

namespace chrono_flow::domain::model
{

/* ----------------------------------------------------- Exceptions ---- */
class ValidationError final : public std::runtime_error
{
public:
    explicit ValidationError(std::string message)
        : std::runtime_error(std::move(message)) {}
};

/* --------------------------------------------------------- Role ---- */
enum class Role
{
    kUser,
    kManager,
    kAdmin
};

inline std::string to_string(Role role)
{
    switch (role)
    {
        case Role::kUser:    return "user";
        case Role::kManager: return "manager";
        case Role::kAdmin:   return "admin";
    }
    return "unknown";
}

inline Role role_from_string(const std::string& s)
{
    if (s == "user")    return Role::kUser;
    if (s == "manager") return Role::kManager;
    if (s == "admin")   return Role::kAdmin;
    throw ValidationError{"Invalid role string: " + s};
}

/* --------------------------------------------------- Preferences ---- */
struct Preferences
{
    bool email_notifications_enabled   {true};
    bool weekly_report_enabled         {false};
    bool dark_mode_enabled             {false};

    // JSON (de)serialization
    friend void to_json(nlohmann::json& j, const Preferences& p)
    {
        j = nlohmann::json{
            {"email_notifications_enabled", p.email_notifications_enabled},
            {"weekly_report_enabled",       p.weekly_report_enabled},
            {"dark_mode_enabled",           p.dark_mode_enabled}
        };
    }

    friend void from_json(const nlohmann::json& j, Preferences& p)
    {
        j.at("email_notifications_enabled").get_to(p.email_notifications_enabled);
        j.at("weekly_report_enabled").get_to(p.weekly_report_enabled);
        j.at("dark_mode_enabled").get_to(p.dark_mode_enabled);
    }
};

/* --------------------------------------------------------- User ---- */
class User
{
public:
    using Id              = boost::uuids::uuid;
    using Clock           = std::chrono::system_clock;
    using TimePoint       = Clock::time_point;
    using RoleSet         = std::unordered_set<Role>;

    /* -------------- Named Ctors -------------------------------------------------- */

    // Creates a brand-new user with a freshly generated UUID.
    // Throws ValidationError if invariants fail.
    static User create_new(
        std::string      display_name,
        std::string      email,
        std::string      time_zone,
        RoleSet          roles       = {Role::kUser},
        Preferences      preferences = {})
    {
        Id id = boost::uuids::random_generator_mt19937{}();
        TimePoint now = Clock::now();
        return User(id, std::move(display_name), std::move(email),
                    std::move(time_zone), std::move(roles),
                    now, now, std::move(preferences));
    }

    // Re-hydrates a user retrieved from the data store (UUID already assigned).
    static User rebuild(
        Id               id,
        std::string      display_name,
        std::string      email,
        std::string      time_zone,
        RoleSet          roles,
        TimePoint        created_at,
        TimePoint        last_modified_at,
        Preferences      preferences)
    {
        return User(id, std::move(display_name), std::move(email),
                    std::move(time_zone), std::move(roles),
                    created_at, last_modified_at, std::move(preferences));
    }

    /* -------------- Observer API ------------------------------------------------- */

    const Id&               id()               const noexcept { return id_; }
    const std::string&      display_name()     const noexcept { return display_name_; }
    const std::string&      email()            const noexcept { return email_; }
    const std::string&      primary_time_zone()const noexcept { return primary_time_zone_; }
    const RoleSet&          roles()            const noexcept { return roles_; }
    const Preferences&      preferences()      const noexcept { return preferences_; }
    TimePoint               created_at()       const noexcept { return created_at_; }
    TimePoint               last_modified_at() const noexcept { return last_modified_at_; }

    bool has_role(Role r) const { return roles_.contains(r); }

    /* -------------- Modifier API ------------------------------------------------- */

    void rename(std::string new_display_name)
    {
        if (new_display_name.empty())
            throw ValidationError{"Display name cannot be empty."};

        display_name_    = std::move(new_display_name);
        touch();
    }

    void change_email(std::string new_email)
    {
        validate_email(new_email);
        email_ = std::move(new_email);
        touch();
    }

    void set_primary_time_zone(std::string tz)
    {
        if (tz.empty())
            throw ValidationError{"Time zone cannot be empty."};

        primary_time_zone_ = std::move(tz);
        touch();
    }

    void add_role(Role r)
    {
        roles_.insert(r);
        touch();
    }

    void remove_role(Role r)
    {
        roles_.erase(r);
        if (roles_.empty())
            roles_.insert(Role::kUser);          // Always retain at least 'user'
        touch();
    }

    void update_preferences(Preferences prefs)
    {
        preferences_ = std::move(prefs);
        touch();
    }

    /* -------------- Equality / Ordering  ---------------------------------------- */

    friend bool operator==(const User& lhs, const User& rhs) noexcept
    {
        return lhs.id_ == rhs.id_;
    }
    friend bool operator!=(const User& lhs, const User& rhs) noexcept
    {
        return !(lhs == rhs);
    }

    /* -------------- JSON Support ------------------------------------------------- */

    friend void to_json(nlohmann::json& j, const User& u)
    {
        j = nlohmann::json{
            {"id",                 boost::uuids::to_string(u.id_)},
            {"display_name",       u.display_name_},
            {"email",              u.email_},
            {"primary_time_zone",  u.primary_time_zone_},
            {"roles",              to_role_strings(u.roles_)},
            {"created_at_epoch_ms", to_epoch_ms(u.created_at_)},
            {"last_modified_at_epoch_ms", to_epoch_ms(u.last_modified_at_)},
            {"preferences",        u.preferences_}
        };
    }

    friend void from_json(const nlohmann::json& j, User& u)
    {
        Id id = boost::uuids::string_generator{}(j.at("id").get<std::string>());

        auto display_name      = j.at("display_name").get<std::string>();
        auto email             = j.at("email").get<std::string>();
        auto tz                = j.at("primary_time_zone").get<std::string>();

        RoleSet roles;
        for (const auto& s : j.at("roles"))
        {
            roles.insert(role_from_string(s.get<std::string>()));
        }

        auto created_ms        = j.at("created_at_epoch_ms").get<int64_t>();
        auto modified_ms       = j.at("last_modified_at_epoch_ms").get<int64_t>();

        Preferences prefs      = j.at("preferences").get<Preferences>();

        u = rebuild(
            id,
            std::move(display_name),
            std::move(email),
            std::move(tz),
            std::move(roles),
            from_epoch_ms(created_ms),
            from_epoch_ms(modified_ms),
            std::move(prefs));
    }

    /* -------------- Hash Support ------------------------------------------------- */

    struct Hasher
    {
        std::size_t operator()(const User& u) const noexcept
        {
            return boost::uuids::hash_value(u.id_);
        }
    };

    /* -------------- Move-only type ---------------------------------------------- */
    User(const User&)            = delete;
    User& operator=(const User&) = delete;
    User(User&&)                 = default;
    User& operator=(User&&)      = default;

private:
    /* -------------- Data Members ------------------------------------------------- */
    Id          id_;
    std::string display_name_;
    std::string email_;
    std::string primary_time_zone_;  // IANA time zone string.
    RoleSet     roles_;
    TimePoint   created_at_;
    TimePoint   last_modified_at_;
    Preferences preferences_;

    /* -------------- Private Ctor ------------------------------------------------- */
    User(
        Id               id,
        std::string      display_name,
        std::string      email,
        std::string      time_zone,
        RoleSet          roles,
        TimePoint        created_at,
        TimePoint        last_modified_at,
        Preferences      preferences)
        : id_(std::move(id))
        , display_name_(std::move(display_name))
        , email_(std::move(email))
        , primary_time_zone_(std::move(time_zone))
        , roles_(std::move(roles))
        , created_at_(created_at)
        , last_modified_at_(last_modified_at)
        , preferences_(std::move(preferences))
    {
        enforce_invariants();
    }

    /* -------------- Helpers ------------------------------------------------------ */

    void enforce_invariants() const
    {
        if (display_name_.empty())
            throw ValidationError{"Display name cannot be empty."};

        validate_email(email_);

        if (primary_time_zone_.empty())
            throw ValidationError{"Time zone cannot be empty."};

        if (roles_.empty())
            throw ValidationError{"User must have at least one role."};
    }

    static void validate_email(const std::string& candidate)
    {
        static const std::regex rx(
            R"(([^@\s]+)@((?:[-a-z0-9]+\.)+[a-z]{2,}))",
            std::regex::icase);

        if (!std::regex_match(candidate, rx))
            throw ValidationError{"Invalid email address: " + candidate};
    }

    void touch() noexcept
    {
        last_modified_at_ = Clock::now();
    }

    static std::vector<std::string> to_role_strings(const RoleSet& rs)
    {
        std::vector<std::string> ret;
        ret.reserve(rs.size());
        for (auto r : rs) ret.push_back(to_string(r));
        return ret;
    }

    static int64_t to_epoch_ms(const TimePoint& tp)
    {
        return std::chrono::duration_cast<std::chrono::milliseconds>(
            tp.time_since_epoch()).count();
    }

    static TimePoint from_epoch_ms(int64_t ms)
    {
        return TimePoint{std::chrono::milliseconds(ms)};
    }
};

} // namespace chrono_flow::domain::model