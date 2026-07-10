#include "domain/model/task.hpp"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <iomanip>
#include <sstream>
#include <spdlog/spdlog.h>
#include <stdexcept>

#include <nlohmann/json.hpp>

namespace chrono_flow::domain::model {

using json = nlohmann::json;
using namespace std::chrono;

/*----------------------------------------------------------
 * Anonymous namespace — helpers local to this compilation
 *----------------------------------------------------------*/
namespace {

constexpr std::size_t kMaxTitleLength = 256;

/**
 * Trims leading and trailing whitespace.
 */
std::string trim(std::string_view sv)
{
    const auto first = std::find_if_not(sv.begin(), sv.end(), ::isspace);
    const auto last  = std::find_if_not(sv.rbegin(), sv.rend(), ::isspace).base();
    return (first < last) ? std::string{first, last} : std::string{};
}

/**
 * Converts a time_point to an ISO-8601 string in UTC.
 * NOTE: A production build would delegate to the project's dedicated
 *       time utility to guarantee identical formatting across modules.
 */
std::string to_iso_utc(const system_clock::time_point& tp)
{
    std::ostringstream oss;
    oss << std::put_time(std::gmtime(&system_clock::to_time_t(tp)), "%FT%TZ");
    return oss.str();
}

} // namespace

/*----------------------------------------------------------
 * Ctors / Dtors
 *----------------------------------------------------------*/
Task::Task(TaskId                                  id,
           std::string                             title,
           std::optional<std::string>              description,
           Status                                  status,
           system_clock::time_point                createdAt,
           std::optional<system_clock::time_point> dueAt,
           std::vector<std::string>                tags)
    : m_id{std::move(id)}
    , m_title{std::move(title)}
    , m_description{std::move(description)}
    , m_status{status}
    , m_createdAt{createdAt}
    , m_updatedAt{createdAt}
    , m_dueAt{std::move(dueAt)}
    , m_tags{std::move(tags)}
{
    validate();                       // domain-level invariants
    m_trackedDuration = duration<double>::zero();
}

/*----------------------------------------------------------
 * Domain-specific operations
 *----------------------------------------------------------*/
void Task::rename(std::string newTitle)
{
    validateTitle(newTitle);

    if (m_title == newTitle)
        return;                      // no-op

    spdlog::info("Task [{}] rename: '{}' -> '{}'", m_id.str(), m_title, newTitle);
    m_title = std::move(newTitle);
    touchUpdatedAt();
}

void Task::changeDescription(std::optional<std::string> newDescription)
{
    if (m_description == newDescription)
        return;

    spdlog::debug("Task [{}] description updated", m_id.str());
    m_description = std::move(newDescription);
    touchUpdatedAt();
}

void Task::addTag(std::string tag)
{
    tag = trim(tag);
    if (tag.empty())
        throw validation_error{"Tag cannot be empty."};

    if (std::find(m_tags.begin(), m_tags.end(), tag) == m_tags.end())
    {
        m_tags.emplace_back(std::move(tag));
        touchUpdatedAt();
    }
}

void Task::removeTag(const std::string& tag)
{
    auto it = std::remove(m_tags.begin(), m_tags.end(), tag);
    if (it != m_tags.end())
    {
        m_tags.erase(it, m_tags.end());
        touchUpdatedAt();
    }
}

void Task::reschedule(const system_clock::time_point& newDue)
{
    if (newDue < m_createdAt)
        throw validation_error{"Due-date must be later than creation date."};

    if (m_dueAt && *m_dueAt == newDue)
        return;

    m_dueAt = newDue;
    spdlog::info("Task [{}] rescheduled to {}", m_id.str(), to_iso_utc(newDue));
    touchUpdatedAt();
}

void Task::markCompleted(const system_clock::time_point& at)
{
    if (m_status == Status::Completed)
        return;

    if (at < m_createdAt)
        throw validation_error{"Completion time cannot precede creation time."};

    m_status      = Status::Completed;
    m_completedAt = at;
    touchUpdatedAt();
}

void Task::reopen()
{
    if (m_status != Status::Completed)
        return;

    m_status      = Status::Open;
    m_completedAt = std::nullopt;
    touchUpdatedAt();
}

void Task::addTimeLog(const TimeLogEntry& entry)
{
    if (entry.start > entry.end)
        throw validation_error{"Timelog start cannot be after end."};

    if (entry.end > system_clock::now())
        throw validation_error{"Timelog end lies in the future."};

    m_timeLog.emplace_back(entry);
    m_trackedDuration = computeTrackedDuration();
    touchUpdatedAt();
}

/*----------------------------------------------------------
 * Query methods
 *----------------------------------------------------------*/
duration<double> Task::computeTrackedDuration() const noexcept
{
    duration<double> sum{0};
    for (const auto& e : m_timeLog)
        sum += (e.end - e.start);
    return sum;
}

json Task::toJson() const
{
    json j{};
    j["id"]           = m_id.str();
    j["title"]        = m_title;
    j["description"]  = m_description.value_or("");
    j["status"]       = statusToString(m_status);
    j["createdAt"]    = to_iso_utc(m_createdAt);
    j["updatedAt"]    = to_iso_utc(m_updatedAt);
    j["dueAt"]        = m_dueAt ? to_iso_utc(*m_dueAt) : nullptr;
    j["completedAt"]  = m_completedAt ? to_iso_utc(*m_completedAt) : nullptr;
    j["tags"]         = m_tags;
    j["trackedSecs"]  = trackedDuration().count();
    return j;
}

/*----------------------------------------------------------
 * Internal helpers
 *----------------------------------------------------------*/
void Task::validateTitle(const std::string& title)
{
    if (title.empty())
        throw validation_error{"Task title must not be empty."};
    if (title.size() > kMaxTitleLength)
        throw validation_error{"Task title exceeds the maximum permitted length."};
}

void Task::validate() const
{
    validateTitle(m_title);

    if (m_dueAt && *m_dueAt < m_createdAt)
        throw validation_error{"Due-date cannot precede creation date."};
}

void Task::touchUpdatedAt() noexcept
{
    m_updatedAt = system_clock::now();
}

std::string Task::statusToString(Status s)
{
    switch (s)
    {
        case Status::Open:        return "OPEN";
        case Status::InProgress:  return "IN_PROGRESS";
        case Status::Completed:   return "COMPLETED";
        case Status::Archived:    return "ARCHIVED";
        default:                  return "UNKNOWN";
    }
}

} // namespace chrono_flow::domain::model