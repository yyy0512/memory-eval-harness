#ifndef PALETTEFLUX_STUDIO_CORE_PERSISTENCE_ASSETREPOSITORY_H_
#define PALETTEFLUX_STUDIO_CORE_PERSISTENCE_ASSETREPOSITORY_H_

/*
 *  PaletteFlux GraphQL Studio
 *  File: AssetRepository.h
 *
 *  Description:
 *      Persistence-layer abstractions for working with creative “Asset” domain
 *      objects.  The repository exposes a clean, technology-agnostic contract
 *      that higher-level services (e.g. GraphQL resolvers, command handlers)
 *      can rely on without knowing whether the data ultimately lives in
 *      Postgres, MongoDB, S3, or an in-memory cache.
 *
 *  The concrete, thread-safe reference implementation included here
 *  (InMemoryAssetRepository) is primarily intended for unit testing and
 *  low-overhead development scenarios. A production deployment would swap in a
 *  database-backed implementation by adhering to the same interface.
 *
 *  Note:
 *      The repository owns the lifetime of returned Asset instances through
 *      shared_ptr to support cross-layer sharing and transparent caching.
 */

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

// Use nlohmann/json for arbitrary user metadata (header-only, lightweight)
#include <nlohmann/json.hpp>

namespace paletteflux::core::domain
{

/*
 *  AssetType
 *  ----------
 *  High-level classification of creative assets.  The list is not exhaustive
 *  and can be easily extended without breaking binary compatibility.
 */
enum class AssetType : std::uint8_t
{
    Brush             = 0x01,
    Texture           = 0x02,
    Shader            = 0x03,
    AnimationCurve    = 0x04,
    AudioLayer        = 0x05,
    // Future asset types...
};

/*
 *  Asset
 *  -----
 *  Lightweight domain model representing a creative artefact.  The struct is
 *  intentionally kept Plain-Old-Data to facilitate (de)serialization across
 *  persistence boundaries.  Business logic (validation, invariants) lives in
 *  service layer.
 */
struct Asset
{
    std::string               id;            // Globally unique, URL-safe identifier (UUID, ULID, etc.)
    AssetType                 type;          // Kind (brush, shader, …)
    std::string               authorUserId;  // Owning artist
    std::chrono::system_clock::time_point
                              createdAt;     // Creation timestamp (UTC)
    std::chrono::system_clock::time_point
                              updatedAt;     // Last modification timestamp (UTC)
    nlohmann::json            metadata;      // Free-form, schema-less metadata (tags, resolution, etc.)

    bool operator==(const Asset& other) const noexcept
    {
        return id == other.id;
    }
};

} // namespace paletteflux::core::domain

namespace paletteflux::core::persistence
{

using domain::Asset;
using domain::AssetType;

/*
 *  RepositoryError
 *  ---------------
 *  Unified exception type signifying problems at the persistence boundary.
 */
class RepositoryError final : public std::runtime_error
{
public:
    explicit RepositoryError(std::string msg)
        : std::runtime_error(std::move(msg))
    {}
};

/*
 *  AssetRepository
 *  ---------------
 *  Technology-agnostic CRUD interface for Asset objects.  Implementations MUST
 *  be thread-safe and exception-neutral.
 */
class AssetRepository
{
public:
    using Ptr = std::shared_ptr<AssetRepository>;

    /*
     *  Observer callback signature for change notifications.  Observers are
     *  triggered AFTER the repository has successfully persisted a mutation.
     */
    using Observer = std::function<void(const Asset& changedAsset)>;

    virtual ~AssetRepository() = default;

    // --- Query API ----------------------------------------------------------

    /*
     *  findById
     *  --------
     *  Attempt to load an Asset given its unique identifier.
     *
     *  @return std::nullopt if the asset does not exist.
     */
    virtual std::optional<std::shared_ptr<Asset>> findById(std::string_view assetId) = 0;

    /*
     *  listByAuthor
     *  ------------
     *  Paginated retrieval of all assets created by the given author.  Caller
     *  can specify offset/limit cursors for pagination.  Results are ordered
     *  by updatedAt descending (most recently modified first).
     */
    virtual std::vector<std::shared_ptr<Asset>> listByAuthor(
        std::string_view authorUserId,
        std::size_t      offset    = 0,
        std::size_t      limit     = 50) = 0;

    /*
     *  queryByMetadata
     *  ---------------
     *  Simple metadata equality query (deep JSON path search delegated to
     *  concrete implementations). If an implementation cannot satisfy the
     *  query it MUST return an empty vector rather than throwing.
     */
    virtual std::vector<std::shared_ptr<Asset>> queryByMetadata(
        std::string_view key,
        const nlohmann::json& value,
        std::size_t      maxResults = 100) = 0;

    // --- Command API --------------------------------------------------------

    /*
     *  save
     *  ----
     *  Insert or update an Asset. Implementations SHOULD perform optimistic
     *  concurrency checks if possible (e.g. compare updatedAt).  On success
     *  all observers will be notified.
     */
    virtual void save(const Asset& asset) = 0;

    /*
     *  remove
     *  ------
     *  Delete an asset permanently. Silently returns if asset does not exist.
     */
    virtual void remove(std::string_view assetId) = 0;

    // --- Observer Registration ---------------------------------------------

    /*
     *  addObserver
     *  -----------
     *  Register a change listener. The method returns an opaque token that can
     *  later be used to unregister the observer.  Observers are executed on
     *  the same thread that invoked the mutating operation; therefore, they
     *  should return quickly and must not throw.
     */
    virtual std::size_t addObserver(Observer observer) = 0;

    /*
     *  removeObserver
     *  --------------
     *  Unregister a previously registered observer by token.
     */
    virtual void removeObserver(std::size_t token) = 0;
};

/*
 *  InMemoryAssetRepository
 *  -----------------------
 *  Reference implementation of AssetRepository backed by an in-process,
 *  thread-safe hash-map.  Suitable for unit tests, prototyping, and
 *  development tools.
 */
class InMemoryAssetRepository final : public AssetRepository
{
public:
    InMemoryAssetRepository() = default;
    ~InMemoryAssetRepository() override = default;

    // Query API --------------------------------------------------------------

    std::optional<std::shared_ptr<Asset>> findById(std::string_view assetId) override
    {
        std::shared_lock lock(_mutex);
        if (auto it = _storage.find(std::string(assetId)); it != _storage.end())
        {
            return it->second;
        }
        return std::nullopt;
    }

    std::vector<std::shared_ptr<Asset>> listByAuthor(
        std::string_view authorUserId,
        std::size_t offset,
        std::size_t limit) override
    {
        std::shared_lock lock(_mutex);

        std::vector<std::shared_ptr<Asset>> results;
        results.reserve(limit);

        for (const auto& [id, assetPtr] : _storage)
        {
            if (assetPtr->authorUserId == authorUserId)
            {
                results.push_back(assetPtr);
            }
        }

        // Sort by updatedAt DESC
        std::sort(results.begin(), results.end(), [](const auto& a, const auto& b) {
            return a->updatedAt > b->updatedAt;
        });

        if (offset >= results.size()) return {};
        const auto begin = results.begin() + static_cast<std::ptrdiff_t>(offset);
        const auto end   = (offset + limit > results.size())
                         ? results.end()
                         : begin + static_cast<std::ptrdiff_t>(limit);
        return {begin, end};
    }

    std::vector<std::shared_ptr<Asset>> queryByMetadata(
        std::string_view key,
        const nlohmann::json& value,
        std::size_t maxResults) override
    {
        std::shared_lock lock(_mutex);

        std::vector<std::shared_ptr<Asset>> results;
        results.reserve(std::min(maxResults, _storage.size()));

        for (const auto& [id, assetPtr] : _storage)
        {
            auto it = assetPtr->metadata.find(std::string(key));
            if (it != assetPtr->metadata.end() && *it == value)
            {
                results.push_back(assetPtr);
                if (results.size() >= maxResults) break;
            }
        }

        return results;
    }

    // Command API -----------------------------------------------------------

    void save(const Asset& asset) override
    {
        std::unique_lock lock(_mutex);

        auto now = std::chrono::system_clock::now();
        auto assetCopy = std::make_shared<Asset>(asset);
        assetCopy->updatedAt = now;
        if (assetCopy->createdAt.time_since_epoch().count() == 0)
        {
            assetCopy->createdAt = now;
        }

        _storage[assetCopy->id] = assetCopy;

        lock.unlock(); // Unlock before notifying observers

        notifyObservers(*assetCopy);
    }

    void remove(std::string_view assetId) override
    {
        std::unique_lock lock(_mutex);
        if (_storage.erase(std::string(assetId)) > 0)
        {
            lock.unlock();
            // Notify observers with a tombstone asset
            Asset tombstone{};
            tombstone.id = std::string(assetId);
            notifyObservers(tombstone);
        }
    }

    // Observer management ----------------------------------------------------

    std::size_t addObserver(Observer observer) override
    {
        std::unique_lock lock(_observerMutex);
        const std::size_t token = ++_observerSeq;
        _observers.emplace(token, std::move(observer));
        return token;
    }

    void removeObserver(std::size_t token) override
    {
        std::unique_lock lock(_observerMutex);
        _observers.erase(token);
    }

private:
    // Notification helper (no locks held)
    void notifyObservers(const Asset& changedAsset)
    {
        std::unordered_map<std::size_t, Observer> shadowCopy;
        {
            std::shared_lock lock(_observerMutex);
            shadowCopy = _observers;
        }

        for (const auto& [token, cb] : shadowCopy)
        {
            try
            {
                cb(changedAsset);
            }
            catch (...) // observers must not break repository invariants
            {
                // Swallow exceptions and continue notifying other observers
            }
        }
    }

    // In-memory store
    std::unordered_map<std::string, std::shared_ptr<Asset>> _storage;
    mutable std::shared_mutex _mutex;

    // Observer list
    std::unordered_map<std::size_t, Observer> _observers;
    std::shared_mutex _observerMutex;
    std::size_t _observerSeq {0};
};

} // namespace paletteflux::core::persistence

#endif // PALETTEFLUX_STUDIO_CORE_PERSISTENCE_ASSETREPOSITORY_H_
