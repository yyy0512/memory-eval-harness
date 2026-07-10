#pragma once

#include <chrono>
#include <cstdint>
#include <exception>
#include <future>
#include <memory>
#include <optional>
#include <string>
#include <system_error>
#include <vector>

namespace paletteflux::studio::core {

// Forward-declaration to break circular-dependencies
namespace model {
class Scene;
}  // namespace model

namespace persistence {

/**
 * Pagination input parameters.
 */
struct PageRequest {
    std::size_t page      = 0;   // 0-based index
    std::size_t pageSize  = 50;  // sensible default

    constexpr std::size_t offset() const noexcept { return page * pageSize; }
};

/**
 * Metadata attached to a paginated query response.
 */
struct PageMetadata {
    std::size_t page          = 0;
    std::size_t pageSize      = 0;
    std::size_t totalElements = 0;
    std::size_t totalPages    = 0;
};

/**
 * Immutable paginated container.
 */
template <typename T>
struct Page {
    std::vector<T> content;
    PageMetadata   meta;
};

/**
 * Raised when a low-level persistence error occurs.
 *
 * The error intentionally carries a secondary diagnostic string so that we can
 * forward relevant information (SQLSTATE, query id, etc.) to observability tools
 * while keeping the primary what() message user-friendly.
 */
class PersistenceError : public std::runtime_error {
public:
    explicit PersistenceError(std::string  message,
                              std::string  diagnostic = {},
                              std::error_code ec      = {}) noexcept
        : std::runtime_error(std::move(message)),
          _diagnostic(std::move(diagnostic)),
          _ec(ec) {}

    [[nodiscard]] const std::string& diagnostic() const noexcept { return _diagnostic; }
    [[nodiscard]] const std::error_code& code() const noexcept { return _ec; }

private:
    std::string     _diagnostic;
    std::error_code _ec;
};

/**
 * Repository interface for Scene aggregate persistence.
 *
 * All methods are expressed as std::future<> so that implementations can
 * delegate blocking IO to a background executor, offering non-blocking semantics
 * to upper layers (e.g. GraphQL resolvers, HTTP handlers, render pipelines).
 *
 * Implementations MUST be thread-safe.
 */
class SceneRepository {
public:
    using ScenePtr = std::shared_ptr<model::Scene>;

    virtual ~SceneRepository() = default;

    /**
     * Persist a new Scene aggregate.
     *
     * @throws PersistenceError if creation fails.
     */
    [[nodiscard]] virtual std::future<ScenePtr>
    create(ScenePtr scene) = 0;

    /**
     * Persist modifications on an existing Scene aggregate.
     *
     * Implementations SHOULD apply optimistic concurrency control
     * (revision/cas column) to protect against lost updates.
     */
    [[nodiscard]] virtual std::future<ScenePtr>
    update(ScenePtr scene) = 0;

    /**
     * Delete a Scene by its id.
     *
     * @return true if an element was removed, false otherwise.
     */
    [[nodiscard]] virtual std::future<bool>
    remove(const std::string& id) = 0;

    /**
     * Retrieve a Scene by its id.
     */
    [[nodiscard]] virtual std::future<std::optional<ScenePtr>>
    findById(const std::string& id) = 0;

    /**
     * Paginated lookup by author.
     */
    [[nodiscard]] virtual std::future<Page<ScenePtr>>
    findByAuthor(const std::string& authorId, const PageRequest& pageRequest) = 0;

    /**
     * Perform a fuzzy search across title, tags, description.
     */
    [[nodiscard]] virtual std::future<Page<ScenePtr>>
    search(const std::string& query, const PageRequest& pageRequest) = 0;

    /**
     * Evict local/process-level cache for the given Scene id, if any.
     */
    virtual void evictCache(const std::string& sceneId) = 0;

    /**
     * Flush write-behind queues, ensuring durability. Useful when
     * orchestrating graceful shutdowns or before mission-critical checkpoints.
     */
    virtual void flush() = 0;
};

}  // namespace persistence
}  // namespace paletteflux::studio::core