```cpp
/**
 * chrono_flow_nexus/src/domain/model/time_entry.cpp
 *
 * Copyright (c) 2023–2024
 * ChronoFlow Nexus – Enterprise Productivity Micro-service
 *
 * Implementation of the domain model `TimeEntry`.
 *
 * A TimeEntry represents a bounded period during which a user was
 * intentionally focused on a specific Task/Project.  The lifetime of a
 * TimeEntry is divided into two distinct phases:
 *
 *  1. Running     – startTime is set, endTime is std::nullopt
 *  2. Completed   – both startTime and endTime are set
 *
 * All mutations are guarded by an internal read/write lock so that the
 * model can be shared safely across threads inside a request-scope actor
 * or an asynchronous command pipeline.
 */

#include "domain/model/time_entry.hpp"

#include <algorithm>
#include <cctype>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <unordered_set>

#include "domain/common/iso_timestamp.hpp"   // utility for (de)serialisation
#include "domain/exception/validation_error.hpp"
#include "infra/logging/logger.hpp"

namespace cfn::domain::model
{
// -----------------------------------------------------------------------------
// ── Helpers
// -----------------------------------------------------------------------------

namespace
{
    /**
     * Validate a tag according to business rules:
     *  - No empty tags
     *  - Max length = 30 UTF-8 code points
     *  - Only printable, non-whitespace characters
     */
    void validateTag(std::string_view raw)
    {
        if (raw.empty())
        {
            throw validation_error{"Tag must not be empty."};
        }
        if (raw.size() > 30)
        {
            throw validation_error{"Tag exceeds maximum length (30)."};
        }

        const auto notAllowed = std::find_if(raw.begin(), raw.end(), [](unsigned char ch) {
            return std::isspace(ch) || !std::isprint(ch);
        });

        if (notAllowed != raw.end())
        {
            throw validation_error{"Tag contains whitespace or non-printable characters."};
        }
    }

    // Trim, lower-case helper – used for canonical representation
    std::string canonicalTag(std::string_view raw)
    {
        auto str = std::string{raw};
        std::transform(str.begin(), str.end(), str.begin(), [](unsigned char ch) {
            return static_cast<char>(std::tolower(ch));
        });
        return str;
    }
} // namespace

// -----------------------------------------------------------------------------
// ── CTOR / DTOR
// -----------------------------------------------------------------------------

TimeEntry::TimeEntry(TimeEntryId                       id,
                     UserId                            userId,
                     TaskId                            taskId,
                     const date_time&                  start,
                     std::optional<date_time>          end,
                     std::string_view                  description,
                     std::vector<std::string>          tags /* move-aware */)
    : m_id{id}
    , m_userId{userId}
    , m_taskId{taskId}
    , m_startTime{start}
    , m_endTime{end}
    , m_description{description}
{
    // Tags are validated and canonicalised only once in the constructor.
    std::unordered_set<std::string> unique;
    unique.reserve(tags.size());

    for (auto& tag : tags)
    {
        validateTag(tag);
        unique.emplace(canonicalTag(tag));
    }

    m_tags.assign(unique.begin(), unique.end());

    if (m_endTime && *m_endTime <= m_startTime)
    {
        throw validation_error{"End time must be later than start time."};
    }
}

// -----------------------------------------------------------------------------
// ── Behavioural methods (write side)
// -----------------------------------------------------------------------------

void TimeEntry::stop(const date_time& end)
{
    std::unique_lock guard{m_mutex};

    if (m_endTime)
    {
        throw validation_error{"TimeEntry is already stopped."};
    }
    if (end <= m_startTime)
    {
        throw validation_error{"End time must be later than start time."};
    }

    m_endTime = end;
}

void TimeEntry::addTag(std::string_view tag)
{
    validateTag(tag);
    const auto canonical = canonicalTag(tag);

    std::unique_lock guard{m_mutex};
    if (std::find(m_tags.begin(), m_tags.end(), canonical) != m_tags.end())
    {
        // Tags are idempotent additions – silently ignore duplicates.
        return;
    }
    m_tags.emplace_back(canonical);
}

void TimeEntry::removeTag(std::string_view tag)
{
    const auto canonical = canonicalTag(tag);

    std::unique_lock guard{m_mutex};
    auto              it = std::remove(m_tags.begin(), m_tags.end(), canonical);
    if (it == m_tags.end())
    {
        throw validation_error{"Tag not present in time entry."};
    }
    m_tags.erase(it, m_tags.end());
}

void TimeEntry::updateDescription(std::string_view description)
{
    std::unique_lock guard{m_mutex};
    m_description = description;
}

// -----------------------------------------------------------------------------
// ── Query methods (read side)
// -----------------------------------------------------------------------------

std::chrono::nanoseconds TimeEntry::duration() const
{
    std::shared_lock guard{m_mutex};

    const auto end = m_endTime.value_or(clock::now());
    return end - m_startTime;
}

bool TimeEntry::isRunning() const
{
    std::shared_lock guard{m_mutex};
    return !m_endTime.has_value();
}

std::vector<std::string> TimeEntry::tags() const
{
    std::shared_lock guard{m_mutex};
    return m_tags; // copy
}

// -----------------------------------------------------------------------------
// ── Serialization helpers
// -----------------------------------------------------------------------------

nlohmann::json TimeEntry::toJson() const
{
    std::shared_lock guard{m_mutex};

    nlohmann::json json;
    json["id"]          = m_id.value();
    json["userId"]      = m_userId.value();
    json["taskId"]      = m_taskId.value();
    json["start"]       = iso_timestamp::toString(m_startTime);
    json["description"] = m_description;
    json["tags"]        = m_tags;

    if (m_endTime)
    {
        json["end"] = iso_timestamp::toString(*m_endTime);
    }
    else
    {
        json["end"] = nullptr;
    }

    return json;
}

// -----------------------------------------------------------------------------

TimeEntry TimeEntry::fromJson(const nlohmann::json& j)
{
    // Required fields
    const auto id          = j.at("id").get<TimeEntryId::value_type>();
    const auto userId      = j.at("userId").get<UserId::value_type>();
    const auto taskId      = j.at("taskId").get<TaskId::value_type>();
    const auto start       = iso_timestamp::fromString(j.at("start").get<std::string>());
    const auto description = j.value("description", "");

    // Optional fields
    std::optional<date_time> end;
    if (!j.at("end").is_null())
    {
        end = iso_timestamp::fromString(j.at("end").get<std::string>());
    }

    const auto tags = j.value("tags", std::vector<std::string>{});

    return TimeEntry{TimeEntryId{id},
                     UserId{userId},
                     TaskId{taskId},
                     start,
                     end,
                     description,
                     tags};
}

} // namespace cfn::domain::model
```