```cpp
#pragma once
/**************************************************************************************************
 * File:    BrushStroke.h
 * Project: PaletteFlux GraphQL Studio – Core Model
 *
 * Description:
 *   Model object that represents an immutable* brush stroke as created by a digital artist on a
 *   drawing tablet.  A brush-stroke is defined as an ordered list of sample points enriched with
 *   per-sample pressure information.  The object exposes convenience utilities such as bounding-
 *   box computation, total path length, JSON (de)serialization and lightweight memory footprint
 *   estimation—all while remaining thread-safe for concurrent readers and a single writer.
 *
 *   (*) The public API does not expose any mutators that would overwrite existing points—new
 *       points can be appended but never removed.  This design plays well with CQRS: the “command”
 *       side creates strokes; the “query” side only observes them.
 *
 * Copyright:
 *   © 2024 PaletteFlux Studio.  All rights reserved.
 **************************************************************************************************/
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <exception>
#include <mutex>
#include <shared_mutex>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>   // MIT licensed single-header JSON library

namespace paletteflux::core::model
{

/* Forward declarations ***************************************************************************************/
class BrushStroke;

/* Helper types ***********************************************************************************************/
using Clock = std::chrono::system_clock;
using TimePoint = Clock::time_point;

/**
 * Bounding rectangle in stroke-local coordinate space.
 */
struct BoundingBox final
{
    float minX {0.F};
    float minY {0.F};
    float maxX {0.F};
    float maxY {0.F};

    [[nodiscard]] constexpr bool isValid() const noexcept
    {
        return minX <= maxX && minY <= maxY;
    }

    [[nodiscard]] constexpr float width() const noexcept
    {
        return maxX - minX;
    }

    [[nodiscard]] constexpr float height() const noexcept
    {
        return maxY - minY;
    }
};

/**
 * One sampled point along the stroke path.
 */
struct StrokePoint final
{
    float      x         {0.F};                                       // Canvas-space X
    float      y         {0.F};                                       // Canvas-space Y
    float      pressure  {1.F};                                       // Normalized 0..1
    TimePoint  timestamp {Clock::now()};                              // When the point was captured

    bool operator==(const StrokePoint& other) const noexcept
    {
        return x == other.x && y == other.y && pressure == other.pressure && timestamp == other.timestamp;
    }
};

/**
 * Production-quality model object representing a brush stroke.
 */
class BrushStroke final
{
public:
    // Public type aliases
    using Id = std::string;
    using container_type = std::vector<StrokePoint>;
    using size_type      = container_type::size_type;

    /*——————————————————————————————————————————————————————————————————————————————
     * Construction / Factory helpers
     *———————————————————————————————————————————————————————————————————————————*/
    static BrushStroke create(const Id& id,
                              std::uint32_t rgba,
                              float thickness)
    {
        return BrushStroke(id, rgba, thickness);
    }

    static BrushStroke fromJson(const nlohmann::json& j)
    {
        if (!j.contains("id") || !j.contains("color") || !j.contains("thickness") || !j.contains("points")) {
            throw std::invalid_argument("BrushStroke::fromJson – missing required fields");
        }

        BrushStroke stroke(j.at("id").get<Id>(),
                           j.at("color").get<std::uint32_t>(),
                           j.at("thickness").get<float>());

        for (const auto& p : j.at("points")) {
            StrokePoint pt;
            pt.x        = p.at("x").get<float>();
            pt.y        = p.at("y").get<float>();
            pt.pressure = p.at("pressure").get<float>();
            pt.timestamp =
                TimePoint{std::chrono::milliseconds{p.at("timestamp").get<std::int64_t>()}};
            stroke.appendPoint(pt);
        }
        return stroke;
    }

    /*——————————————————————————————————————————————————————————————————————————————
     * Non-copyable / Movable
     *———————————————————————————————————————————————————————————————————————————*/
    BrushStroke(const BrushStroke&) = delete;
    BrushStroke& operator=(const BrushStroke&) = delete;

    BrushStroke(BrushStroke&&) noexcept            = default;
    BrushStroke& operator=(BrushStroke&&) noexcept = default;

    /*——————————————————————————————————————————————————————————————————————————————
     * Observers
     *———————————————————————————————————————————————————————————————————————————*/
    [[nodiscard]] const Id& id() const noexcept { return m_id; }
    [[nodiscard]] std::uint32_t color() const noexcept { return m_color; }
    [[nodiscard]] float thickness() const noexcept { return m_thickness; }
    [[nodiscard]] TimePoint createdAt() const noexcept { return m_createdAt; }
    [[nodiscard]] TimePoint updatedAt() const noexcept { return m_updatedAt; }

    [[nodiscard]] size_type size() const noexcept
    {
        const std::shared_lock lock(m_mutex);
        return m_points.size();
    }

    [[nodiscard]] bool empty() const noexcept { return size() == 0; }

    [[nodiscard]] container_type pointsCopy() const
    {
        const std::shared_lock lock(m_mutex);
        return m_points;
    }

    /**
     * Returns a thread-safe snapshot of the bounding box; lazily recomputed
     * only if new points have been appended since the last call.
     */
    [[nodiscard]] BoundingBox boundingBox() const
    {
        std::shared_lock sLock(m_mutex);
        if (!m_bboxCache || m_bboxDirty) {
            // Promote to unique lock for computation
            sLock.unlock();
            std::unique_lock uLock(m_mutex);

            // Double-checked locking
            if (!m_bboxCache || m_bboxDirty) {
                m_bboxCache = computeBoundingBox();
                m_bboxDirty = false;
            }
            return *m_bboxCache;
        }
        return *m_bboxCache;
    }

    /**
     * Calculates the total path length (Euclidean distance between consecutive points).
     */
    [[nodiscard]] float length() const
    {
        const std::shared_lock lock(m_mutex);
        if (m_points.size() < 2) { return 0.F; }

        float dist = 0.F;
        for (size_type i = 1; i < m_points.size(); ++i) {
            const auto& a = m_points[i - 1];
            const auto& b = m_points[i];
            const float dx = b.x - a.x;
            const float dy = b.y - a.y;
            dist += std::sqrt(dx * dx + dy * dy);
        }
        return dist;
    }

    /**
     * Rough estimation of heap memory consumed by this stroke.
     * Useful for memory budgets and cache eviction policies.
     */
    [[nodiscard]] std::size_t memoryFootprint() const noexcept
    {
        const std::shared_lock lock(m_mutex);
        return sizeof(BrushStroke) + (sizeof(StrokePoint) * m_points.capacity());
    }

    /**
     * Serializes the whole stroke to JSON.
     */
    [[nodiscard]] nlohmann::json toJson() const
    {
        const std::shared_lock lock(m_mutex);

        nlohmann::json j;
        j["id"]        = m_id;
        j["color"]     = m_color;
        j["thickness"] = m_thickness;
        j["created"]   = std::chrono::duration_cast<std::chrono::milliseconds>(
                             m_createdAt.time_since_epoch())
                             .count();
        j["updated"] = std::chrono::duration_cast<std::chrono::milliseconds>(
                           m_updatedAt.time_since_epoch())
                           .count();

        j["points"] = nlohmann::json::array();
        for (const auto& p : m_points) {
            nlohmann::json jp;
            jp["x"]         = p.x;
            jp["y"]         = p.y;
            jp["pressure"]  = p.pressure;
            jp["timestamp"] = std::chrono::duration_cast<std::chrono::milliseconds>(
                                  p.timestamp.time_since_epoch())
                                  .count();
            j["points"].push_back(std::move(jp));
        }
        return j;
    }

    /*——————————————————————————————————————————————————————————————————————————————
     * Mutators  (single-writer principle enforced by exclusive lock)
     *———————————————————————————————————————————————————————————————————————————*/
    /**
     * Append a new sample point to the stroke.
     * Throws std::invalid_argument if the point's timestamp is older than the last point
     * (temporal monotonicity guard).
     */
    void appendPoint(const StrokePoint& pt)
    {
        std::unique_lock lock(m_mutex);
        if (!m_points.empty() && pt.timestamp < m_points.back().timestamp) {
            throw std::invalid_argument(
                "BrushStroke::appendPoint – timestamps must be non-decreasing");
        }

        m_points.push_back(pt);
        m_bboxDirty = true;
        m_updatedAt = Clock::now();
    }

    void appendPoint(float x, float y, float pressure = 1.F, TimePoint ts = Clock::now())
    {
        appendPoint(StrokePoint{x, y, pressure, ts});
    }

    /**
     * Reserve capacity in the underlying container to prevent reallocations during sampling.
     */
    void reserve(size_type newCapacity)
    {
        std::unique_lock lock(m_mutex);
        m_points.reserve(newCapacity);
    }

private:
    /*——————————————————————————————————————————————————————————————————————————————
     * Data members (observable via accessors only)
     *———————————————————————————————————————————————————————————————————————————*/
    Id             m_id;
    std::uint32_t  m_color;                       // Packed RGBA (0xRRGGBBAA)
    float          m_thickness;                   // Visual stroke width in pixels
    TimePoint      m_createdAt;
    TimePoint      m_updatedAt;

    container_type m_points;                      // Sample points (append-only)

    mutable std::optional<BoundingBox> m_bboxCache;
    mutable bool                       m_bboxDirty {true};

    mutable std::shared_mutex m_mutex;            // Readers/Writer lock

    /*——————————————————————————————————————————————————————————————————————————————
     * Private helpers
     *———————————————————————————————————————————————————————————————————————————*/
    BrushStroke(Id id, std::uint32_t rgba, float thickness)
        : m_id(std::move(id))
        , m_color(rgba)
        , m_thickness(thickness)
        , m_createdAt(Clock::now())
        , m_updatedAt(m_createdAt)
    {
        if (thickness <= 0.F) {
            throw std::invalid_argument("BrushStroke – thickness must be positive");
        }
    }

    BoundingBox computeBoundingBox() const
    {
        if (m_points.empty()) { return {}; }

        BoundingBox bb;
        bb.minX = bb.maxX = m_points.front().x;
        bb.minY = bb.maxY = m_points.front().y;

        for (const auto& p : m_points) {
            bb.minX = std::min(bb.minX, p.x);
            bb.maxX = std::max(bb.maxX, p.x);
            bb.minY = std::min(bb.minY, p.y);
            bb.maxY = std::max(bb.maxY, p.y);
        }
        return bb;
    }
};

/*——————————————————————————————————————————————————————————————————————————————
 * JSON (de)serialization glue for nlohmann::json (ADL friendly)
 *———————————————————————————————————————————————————————————————————————————*/
inline void to_json(nlohmann::json& j, const BrushStroke& stroke)
{
    j = stroke.toJson();
}

inline void from_json(const nlohmann::json& j, BrushStroke& stroke)
{
    stroke = BrushStroke::fromJson(j);
}

} // namespace paletteflux::core::model
```