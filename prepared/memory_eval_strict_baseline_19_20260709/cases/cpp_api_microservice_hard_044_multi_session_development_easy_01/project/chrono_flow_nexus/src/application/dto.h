```cpp
#pragma once
/***************************************************************************************************
 * ChronoFlow Nexus – DTO Layer
 * ---------------------------------------------------
 * This header centralises all Data-Transfer-Objects that cross the “application ⇆ interface”
 * boundary.  DTOs are intentionally flat, validation-ready, and JSON-serialisable so that:
 *
 *   •  The transport layer (REST/GraphQL) can remain agnostic of deeper domain models.
 *   •  The application layer can evolve independently of external contracts.
 *
 *  NOTE:  Do not leak domain invariants into this layer.  Keep DTOs dumb; validation should only
 *  protect the *shape* of incoming data, leaving semantic correctness to higher layers.
 *
 *  Author: ChronoFlow Nexus core team
 **************************************************************************************************/

#include <chrono>
#include <cstdint>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace chrono_flow::application
{

using json = ::nlohmann::json;

/*--------------------------------------------------------------------------------------------------
 * Exception types
 *------------------------------------------------------------------------------------------------*/

class dto_error final : public std::invalid_argument
{
public:
    explicit dto_error(std::string_view message)
        : std::invalid_argument{std::string{message}}
    {}
};

/*--------------------------------------------------------------------------------------------------
 * Helper concepts / traits
 *------------------------------------------------------------------------------------------------*/

template <typename T>
concept JsonSerializable = requires(const T& obj, json& j)
{
    { T::from_json(j) } -> std::same_as<T>;
    { obj.to_json() } -> std::same_as<json>;
};

namespace detail
{
    template <typename Rep, typename Period = std::ratio<1>>
    void ensure_positive_duration(const std::chrono::duration<Rep, Period>& d,
                                  std::string_view field_name)
    {
        if (d.count() <= 0)
        {
            throw dto_error{field_name.data() + std::string{" must be > 0"}};
        }
    }
} // namespace detail

/*--------------------------------------------------------------------------------------------------
 * Base DTO
 *------------------------------------------------------------------------------------------------*/

struct BaseDTO
{
    virtual ~BaseDTO() = default;

    virtual json to_json() const = 0;

    // Throws dto_error on failure.
    virtual void validate() const = 0;
};

/*--------------------------------------------------------------------------------------------------
 * PaginationDTO
 *------------------------------------------------------------------------------------------------*/

struct PaginationDTO : public BaseDTO
{
    std::uint32_t page     = 1;  // 1-based index
    std::uint32_t per_page = 50; // max items per page

    static constexpr std::uint32_t kMaxPerPage = 250;

    void validate() const override
    {
        if (page == 0)
            throw dto_error{"page must be ≥ 1"};
        if (per_page == 0 || per_page > kMaxPerPage)
            throw dto_error{"per_page must be in [1, " + std::to_string(kMaxPerPage) + ']'};
    }

    json to_json() const override
    {
        return json{{"page", page}, {"per_page", per_page}};
    }

    static PaginationDTO from_json(const json& j)
    {
        PaginationDTO dto;
        dto.page     = j.value("page", dto.page);
        dto.per_page = j.value("per_page", dto.per_page);
        dto.validate();
        return dto;
    }
};

/*--------------------------------------------------------------------------------------------------
 * TimeRangeDTO
 *------------------------------------------------------------------------------------------------*/

struct TimeRangeDTO : public BaseDTO
{
    std::chrono::system_clock::time_point from{};
    std::chrono::system_clock::time_point to{};

    void validate() const override
    {
        if (to <= from)
            throw dto_error{"'to' must be after 'from'"};
    }

    json to_json() const override
    {
        // Milliseconds since epoch
        auto tp_to_ms = [](const auto& tp)
        {
            return std::chrono::duration_cast<std::chrono::milliseconds>(
                       tp.time_since_epoch())
                .count();
        };

        return json{{"from", tp_to_ms(from)}, {"to", tp_to_ms(to)}};
    }

    static TimeRangeDTO from_json(const json& j)
    {
        auto ms_to_tp = [](std::int64_t ms)
        {
            return std::chrono::system_clock::time_point{
                std::chrono::milliseconds{ms}};
        };

        TimeRangeDTO dto;
        dto.from = ms_to_tp(j.at("from").get<std::int64_t>());
        dto.to   = ms_to_tp(j.at("to").get<std::int64_t>());
        dto.validate();
        return dto;
    }
};

/*--------------------------------------------------------------------------------------------------
 * SortOrder enum
 *------------------------------------------------------------------------------------------------*/

enum class SortOrder : std::uint8_t
{
    Asc,
    Desc,
};

inline std::string_view to_string(SortOrder o) noexcept
{
    return o == SortOrder::Asc ? "asc" : "desc";
}

inline SortOrder sort_order_from_string(std::string_view s)
{
    if (s == "asc")
        return SortOrder::Asc;
    if (s == "desc")
        return SortOrder::Desc;
    throw dto_error{"invalid sort order: expected 'asc' or 'desc'"};
}

/*--------------------------------------------------------------------------------------------------
 * TaskAnalyticsQueryDTO
 *------------------------------------------------------------------------------------------------*/

struct TaskAnalyticsQueryDTO : public BaseDTO
{
    TimeRangeDTO                       range;
    PaginationDTO                      pagination;
    SortOrder                          order  = SortOrder::Desc;
    std::optional<std::vector<std::string>> tags; // filter by one or more tags

    void validate() const override
    {
        range.validate();
        pagination.validate();
        // tags may be empty; no extra validation
    }

    json to_json() const override
    {
        json j;
        j["range"]      = range.to_json();
        j["pagination"] = pagination.to_json();
        j["order"]      = to_string(order);
        if (tags && !tags->empty())
            j["tags"] = *tags;
        return j;
    }

    static TaskAnalyticsQueryDTO from_json(const json& j)
    {
        TaskAnalyticsQueryDTO dto;
        dto.range      = TimeRangeDTO::from_json(j.at("range"));
        dto.pagination = PaginationDTO::from_json(j.at("pagination"));
        dto.order      = sort_order_from_string(j.value("order", "desc"));
        if (j.contains("tags"))
            dto.tags = j.at("tags").get<std::vector<std::string>>();

        dto.validate();
        return dto;
    }
};

/*--------------------------------------------------------------------------------------------------
 * ADL to/from json helpers (for nlohmann::json serialisation)
 *------------------------------------------------------------------------------------------------*/

inline void to_json(json& j, const PaginationDTO& dto) { j = dto.to_json(); }

inline void from_json(const json& j, PaginationDTO& dto) { dto = PaginationDTO::from_json(j); }

inline void to_json(json& j, const TimeRangeDTO& dto) { j = dto.to_json(); }

inline void from_json(const json& j, TimeRangeDTO& dto) { dto = TimeRangeDTO::from_json(j); }

inline void to_json(json& j, const TaskAnalyticsQueryDTO& dto) { j = dto.to_json(); }

inline void from_json(const json& j, TaskAnalyticsQueryDTO& dto)
{
    dto = TaskAnalyticsQueryDTO::from_json(j);
}

} // namespace chrono_flow::application
```