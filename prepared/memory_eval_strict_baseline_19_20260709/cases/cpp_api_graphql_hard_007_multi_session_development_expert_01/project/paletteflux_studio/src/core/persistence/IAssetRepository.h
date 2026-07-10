```cpp
/**
 * PaletteFlux Studio
 * File: paletteflux_studio/src/core/persistence/IAssetRepository.h
 *
 * Copyright (c) PaletteFlux.
 *
 * Licensed under the MIT License. See LICENSE file in the project root for
 * full license information.
 *
 * ---------------------------------------------------------------------------
 *  Description
 * ---------------------------------------------------------------------------
 *  Core, persistence-layer abstraction that encapsulates the storage and
 *  retrieval strategies for Asset entities.  Implementations of this
 *  interface may target SQL/NoSQL databases, distributed KV stores,
 *  in-memory caches, or any combination thereof.  The contract purposefully
 *  hides underlying technology choices from the Service layer, permitting
 *  hot-swapping of persistence mechanisms without touching business logic.
 *
 *  The repository is designed to be:
 *    • Asynchronous (std::future-based) to avoid blocking I/O on hot paths
 *    • Exception-safe — throws domain-specific exceptions only
 *    • Transactional — explicit transaction boundary control
 *    • Thread-safe — const-qualified reads / synchronized mutations
 */

#pragma once

#include <chrono>
#include <cstdint>
#include <future>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace paletteflux::core
{
    // Forward declarations to decouple headers.
    namespace model
    {
        class Asset;      // See: paletteflux_studio/src/core/model/Asset.h
    }

    namespace exceptions
    {
        /**
         * Thin wrappers around std::runtime_error that allow the caller to
         * disambiguate failure sources while still providing a single catch
         * point (std::exception) for generic error handling.
         */
        class PersistenceError : public std::runtime_error
        {
        public:
            explicit PersistenceError(std::string msg)
                : std::runtime_error{ std::move(msg) }
            {}
        };

        class UniqueConstraintViolation : public PersistenceError
        {
        public:
            explicit UniqueConstraintViolation(const std::string& field,
                                               const std::string& value)
                : PersistenceError{ "Unique constraint violated on field '" + field +
                                    "' with value '" + value + "'" }
            {}
        };

        class TransactionError : public PersistenceError
        {
        public:
            explicit TransactionError(std::string msg)
                : PersistenceError{ std::move(msg) }
            {}
        };
    } // namespace exceptions

    namespace persistence
    {
        /**
         * Lightweight pagination descriptor.
         */
        struct PageRequest final
        {
            std::size_t offset{ 0 };  // Starting row
            std::size_t limit{ 50 };  // Maximum number of records to return

            constexpr PageRequest(std::size_t off = 0, std::size_t lim = 50)
                : offset{ off }
                , limit{ lim }
            {}
        };

        /**
         * Paged result containing total row count for the requested query.
         */
        template <typename T>
        struct Page final
        {
            std::vector<T>          rows;
            std::size_t             totalRecords{ 0 };
            std::size_t             offset{ 0 };
            std::size_t             limit{ 0 };

            constexpr bool isEmpty() const noexcept { return rows.empty(); }
        };

        /**
         * Elastic filter for lookup queries.
         *
         * Additional fields should be appended as business requirements evolve.
         */
        struct AssetFilter final
        {
            std::optional<std::string>                 ownerId;        // Filter by creator / owner
            std::optional<std::string>                 mimeType;       // e.g. "image/png"
            std::optional<std::chrono::system_clock::time_point> createdAfter;
            std::optional<std::chrono::system_clock::time_point> createdBefore;
            std::optional<std::vector<std::string>>    tags;           // Full-match for now

            bool isEmpty() const noexcept
            {
                return !(ownerId || mimeType || createdAfter || createdBefore || tags);
            }
        };

        /**
         * Primary Repository interface for Assets.
         *
         * All methods are asynchronous and must be awaited by the caller in
         * client code (via std::future::get, co_await with coroutines, etc.).
         *
         * Implementations should guarantee:
         *   • Strong exception safety
         *   • Deadlock-free thread safety
         *   • Non-blocking I/O where feasible
         */
        class IAssetRepository
        {
        public:
            virtual ~IAssetRepository() noexcept = default;

            /**
             * Retrieve a single Asset by its stable identifier.
             *
             * @returns future<shared_ptr<const Asset>>, where the shared_ptr
             *          is nullptr if the asset is not found.
             * @throws  PersistenceError on read failure.
             */
            [[nodiscard]]
            virtual std::future<std::shared_ptr<const model::Asset>>
            findById(const std::string& assetId) const = 0;

            /**
             * Stream all Assets matching the supplied filter and page spec.
             *
             * @throws PersistenceError
             */
            [[nodiscard]]
            virtual std::future<Page<std::shared_ptr<const model::Asset>>>
            findAll(const AssetFilter& filter,
                    const PageRequest& page) const = 0;

            /**
             * Persist or update an Asset record.  Implementations should
             * perform an "upsert" — insert when not present, otherwise update.
             *
             * @throws UniqueConstraintViolation
             * @throws PersistenceError
             */
            virtual std::future<void> save(const model::Asset& asset) = 0;

            /**
             * Permanently remove an Asset, including any blobs/binary payloads.
             *
             * @throws PersistenceError
             */
            virtual std::future<void> remove(const std::string& assetId) = 0;

            /**
             * Batching operations can be wrapped inside an explicit
             * transaction to guarantee atomicity across multiple repo calls.
             * Implementations that do not support transactions MUST throw
             * TransactionError.
             */
            virtual std::future<void> beginTransaction() = 0;
            virtual std::future<void> commitTransaction() = 0;
            virtual std::future<void> rollbackTransaction() = 0;

            /**
             * Health probe mainly used by readiness / liveness checks in
             * orchestration platforms (Kubernetes, Nomad, etc.).
             *
             * Implementations should validate connectivity with the backing
             * store (e.g. test SQL connection, ping Redis, etc.).
             * A successful future<void> indicates the repo is healthy.
             *
             * @throws PersistenceError when the health check fails.
             */
            [[nodiscard]]
            virtual std::future<void> ping() const = 0;
        };

        using IAssetRepositoryPtr = std::shared_ptr<IAssetRepository>;

    } // namespace persistence
}     // namespace paletteflux::core
```