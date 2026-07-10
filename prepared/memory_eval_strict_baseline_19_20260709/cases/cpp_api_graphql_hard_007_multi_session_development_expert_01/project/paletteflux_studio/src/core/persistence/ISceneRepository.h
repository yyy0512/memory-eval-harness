#pragma once
/**
 * PaletteFlux GraphQL Studio
 * File: paletteflux_studio/src/core/persistence/ISceneRepository.h
 *
 * Copyright (c) PaletteFlux
 *
 * Licensed under MIT License.  See LICENSE file in the project root for details.
 *
 * -------------------------------------------------------------------------------
 *  Description
 * -------------------------------------------------------------------------------
 *  Defines the repository interface responsible for persisting and retrieving
 *  Scene aggregates.  The repository acts as an abstraction layer, isolating
 *  higher-level command/query handlers from the underlying storage mechanism
 *  (PostgreSQL, MongoDB, Neo4j, S3, etc.).  All methods are asynchronous and
 *  return std::future<T> to encourage non-blocking I/O on the call-site.
 *
 *  The interface is intentionally implementation-agnostic; any concrete provider
 *  must honour the contract but may choose its own consistency guarantees
 *  (optimistic, pessimistic, event-sourced, CQRS write model, etc.).
 *
 *  Thread-safety: Implementations MUST be safe for concurrent access.
 */

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <future>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

namespace paletteflux::core::persistence
{

// -----------------------------------------------------------------------------
// Helper aliases / data-transfer objects
// -----------------------------------------------------------------------------

using SceneId = std::string;

/**
 * Strongly typed revision descriptor used by clients who wish to query an
 * historical snapshot (time-travel / audit log) of a Scene.
 */
struct Revision
{
    std::uint64_t                           version {0};
    std::chrono::system_clock::time_point   timestamp {};

    friend bool operator==(const Revision& lhs, const Revision& rhs) noexcept
    {
        return lhs.version == rhs.version && lhs.timestamp == rhs.timestamp;
    }
    friend bool operator!=(const Revision& lhs, const Revision& rhs) noexcept
    {
        return !(lhs == rhs);
    }
};

/**
 * Lightweight projection of a Scene used for pagination lists.
 */
struct SceneSummary
{
    SceneId      id;
    std::string  displayName;
    Revision     currentRevision;
    std::string  ownerUserId;      // Security / ACL can be handled downstream.
    std::chrono::system_clock::time_point lastModifiedUtc;
};

/**
 * Full, serialised representation of the Scene aggregate.  The wire-format is
 * left to the implementation: msgpack, json, protobuf, flatbuffer, etc.
 */
struct SceneSnapshot
{
    SceneSummary                     header;

    // GraphQL representation requested frequently by interactive clients.
    std::string                      graphQLPayload;

    // Binary payload used by low-latency render pipelines (texture atlases,
    // GPU-ready blobs, etc.)
    std::vector<std::byte>           binaryPayload;

    // Additional metadata (e.g., ETag, content hash, encryption keys).
    std::optional<std::string>       metadataJson;
};

/**
 * Pagination request descriptor.
 */
struct PageRequest
{
    std::size_t  offset  {0};
    std::size_t  limit   {50};
};

/**
 * Pagination response metadata returned along the result set.
 */
struct PageMetadata
{
    std::size_t  totalItems   {0};
    bool         hasMore      {false};
};

/**
 * Parameter object for repository queries, allowing composable filters.
 */
struct SceneFilter
{
    std::optional<std::string> ownerUserId;
    std::optional<std::string> nameContains;
    std::optional<std::chrono::system_clock::time_point> modifiedAfterUtc;
};

/**
 * Exception type thrown by repositories when operations fail *after*
 * communication with the storage layer succeeded (e.g., validation issues,
 * optimistic-concurrency conflicts, etc.).
 */
class RepositoryException : public std::runtime_error
{
public:
    explicit RepositoryException(std::string_view message,
                                 std::error_code    ec = {})
        : std::runtime_error{std::string{message}}
        , _ec{ec}
    {}

    [[nodiscard]] std::error_code code() const noexcept { return _ec; }

private:
    std::error_code _ec;
};

// -----------------------------------------------------------------------------
// Interface definition
// -----------------------------------------------------------------------------

class ISceneRepository
{
public:
    virtual ~ISceneRepository() noexcept = default;

    /**
     * Returns a snapshot of the Scene identified by the given id.
     *
     * @param id      Scene aggregate root id.
     * @param asOf    Optional revision to time-travel to; if empty, the latest
     *                revision is returned.
     * @return        Future containing optional snapshot; empty if not found.
     */
    [[nodiscard]]
    virtual std::future<std::optional<SceneSnapshot>>
    fetchByIdAsync(const SceneId& id,
                   std::optional<Revision> asOf = std::nullopt) const = 0;

    /**
     * Returns a paginated list of Scene summaries.
     *
     * @param pageRequest    Zero-based offset/limit descriptor.
     * @param filter         Optional filter criteria.
     * @return               Future containing pair<metadata, summaries>.
     */
    [[nodiscard]]
    virtual std::future<std::pair<PageMetadata, std::vector<SceneSummary>>>
    fetchPageAsync(const PageRequest& pageRequest,
                   std::optional<SceneFilter> filter = std::nullopt) const = 0;

    /**
     * Persists a SceneSnapshot, returning the stored version (including updated
     * revision number and timestamps).  Implementations must apply optimistic
     * concurrency control using the Revision contained in SceneSnapshot.header.
     *
     * @throws RepositoryException if concurrency violation or validation error.
     */
    [[nodiscard]]
    virtual std::future<SceneSnapshot>
    persistAsync(SceneSnapshot snapshot) = 0;

    /**
     * Physically deletes a Scene aggregate.  Implementations may soft-delete
     * (tombstone) instead of hard-delete as required for audit reasons.
     *
     * @throws RepositoryException if Scene not found / ACL denied.
     */
    [[nodiscard]]
    virtual std::future<void> removeAsync(const SceneId& id) = 0;

    /**
     * Registers an observer for the given SceneId.  The callback MUST be
     * non-blocking and must not throw.  Implementations return a void* token
     * which the caller can store for later unsubscription.  The token is
     * implementation-defined and *never* dereferenced by callers.
     *
     * @return Subscriber key that must be used for unsubscription.
     */
    [[nodiscard]]
    virtual const void*
    subscribe(const SceneId& id,
              std::function<void(const SceneSnapshot&)> callback) = 0;

    /**
     * Unsubscribes the previously registered observer.
     *
     * @param id           Scene aggregate root id.
     * @param subscriber   Token returned by subscribe().
     */
    virtual void unsubscribe(const SceneId& id,
                             const void* subscriber) noexcept = 0;
};

using ISceneRepositoryPtr = std::shared_ptr<ISceneRepository>;

} // namespace paletteflux::core::persistence