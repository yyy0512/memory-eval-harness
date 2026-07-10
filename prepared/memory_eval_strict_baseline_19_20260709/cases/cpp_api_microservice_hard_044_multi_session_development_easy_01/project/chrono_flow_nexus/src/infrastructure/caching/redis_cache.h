#pragma once
/**
 *  chrono_flow_nexus/src/infrastructure/caching/redis_cache.h
 *
 *  ChronoFlow Nexus – Infrastructure Layer
 *  ----------------------------------------
 *  Redis-backed, typed, production-grade cache with pluggable serialization.
 *
 *  The cache purposely exposes a small but expressive API surface:
 *    • get / set for single keys
 *    • bulk variants (get_many / set_many) powered by Redis pipelining
 *    • invalidate & flush helpers
 *
 *  Internally it relies on redis-plus-plus (https://github.com/sewenew/redis-plus-plus)
 *  for connection management and command execution, while using nlohmann::json
 *  for (de)serializing arbitrary value types that comply with the JSON concept.
 *
 *  NOTE: Implementation lives in the header because most functions are templates
 *  and must be visible at call-site to allow the compiler to generate code.
 */

#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

namespace chrono_flow::infra::caching {

/**
 * Generic cache exception type thrown for recoverable, cache-specific failures.
 */
class CacheError final : public std::runtime_error
{
public:
    explicit CacheError(const std::string& what)
        : std::runtime_error{what}
    {}
};

/**
 * A thin, RAII wrapper around a redis-plus-plus connection that provides
 * type-safe get/set helpers and sensible error handling semantics.
 */
class RedisCache
{
public:
    /**
     * Construct a RedisCache that connects eagerly to the supplied URI.
     *
     * @param redis_uri   Format example: "tcp://localhost:6379?timeout=3"
     * @param default_ttl Default TTL applied when the caller does not pass one
     */
    explicit RedisCache(std::string redis_uri,
                        std::chrono::milliseconds default_ttl = std::chrono::minutes{5})
        : _redis{std::move(redis_uri)}, _default_ttl{default_ttl}
    {
        // Validate connection up-front so we fail fast during service start-up.
        try
        {
            _redis.ping();
        }
        catch (const sw::redis::Error& ex)
        {
            throw CacheError{"Failed to connect to Redis: " + std::string{ex.what()}};
        }
    }

    RedisCache(const RedisCache&)            = delete;
    RedisCache& operator=(const RedisCache&) = delete;
    RedisCache(RedisCache&&)                 = default;
    RedisCache& operator=(RedisCache&&)      = default;
    ~RedisCache()                            = default;

    /**
     * Write a value to the cache.
     *
     * @param key   Cache key
     * @param value Anything serializable via nlohmann::json or convertible to std::string
     * @param ttl   Optional TTL for this entry (0 => use default_ttl, negative => no expiry)
     */
    template <typename T>
    void set(const std::string& key, const T& value,
             std::chrono::milliseconds ttl = std::chrono::milliseconds{0})
    {
        try
        {
            const std::string blob = serialize(value);

            if (ttl == std::chrono::milliseconds{0})
            {
                ttl = _default_ttl;
            }

            if (ttl.count() < 0)
            {
                _redis.set(key, blob);  // no expiry
            }
            else
            {
                _redis.setex(key, static_cast<long long>(ttl.count() / 1000), blob);
            }
        }
        catch (const sw::redis::Error& ex)
        {
            throw CacheError{"Redis SET failed: " + std::string{ex.what()}};
        }
    }

    /**
     * Retrieve a typed value from the cache.
     *
     * @return std::nullopt when the key is missing or the blob cannot be deserialized
     */
    template <typename T>
    std::optional<T> get(const std::string& key) const
    {
        try
        {
            auto res = _redis.get(key);
            if (!res)
            {
                return std::nullopt;
            }
            return deserialize<T>(*res);
        }
        catch (const sw::redis::Error& ex)
        {
            throw CacheError{"Redis GET failed: " + std::string{ex.what()}};
        }
        catch (const std::exception& ex)
        {
            // Deserialization failure – treat as cache miss
            return std::nullopt;
        }
    }

    /**
     * Bulk-set a range of key/value pairs using a single pipeline round-trip.
     *
     * Range requirements:
     *   – value_type is std::pair<std::string, T>
     *   – supports std::begin / std::end
     */
    template <typename Range>
    void set_many(const Range& kv_pairs,
                  std::chrono::milliseconds ttl = std::chrono::milliseconds{0})
    {
        if (ttl == std::chrono::milliseconds{0})
        {
            ttl = _default_ttl;
        }

        try
        {
            auto pipe = _redis.pipeline(/*new*/ true);

            for (const auto& [key, val] : kv_pairs)
            {
                const auto blob = serialize(val);
                if (ttl.count() < 0)
                {
                    pipe.set(key, blob);
                }
                else
                {
                    pipe.setex(key, static_cast<long long>(ttl.count() / 1000), blob);
                }
            }
            pipe.exec();
        }
        catch (const sw::redis::Error& ex)
        {
            throw CacheError{"Redis pipeline SET failed: " + std::string{ex.what()}};
        }
    }

    /**
     * Bulk-get helper. Deserialized results are pushed into the OutputIterator
     * in the same order as keys supplied. Missing keys => std::optional<T>{}
     *
     * Example:
     *   std::vector<std::optional<MyDto>> out;
     *   cache.get_many(keys, std::back_inserter(out));
     */
    template <typename OutputIt, typename T = typename OutputIt::value_type::value_type>
    void get_many(const std::vector<std::string>& keys, OutputIt out) const
    {
        try
        {
            auto pipe = _redis.pipeline(/*new*/ false);
            std::vector<sw::redis::FutureOptionalString> futures;
            futures.reserve(keys.size());

            for (const auto& key : keys)
            {
                futures.emplace_back(pipe.get(key));
            }

            pipe.exec();

            for (auto& fut : futures)
            {
                try
                {
                    auto raw = fut.get();
                    if (raw)
                    {
                        *out++ = deserialize<T>(*raw);
                    }
                    else
                    {
                        *out++ = std::nullopt;
                    }
                }
                catch (...)
                {
                    *out++ = std::nullopt;  // Treat partial errors as cache miss
                }
            }
        }
        catch (const sw::redis::Error& ex)
        {
            throw CacheError{"Redis pipeline GET failed: " + std::string{ex.what()}};
        }
    }

    /**
     * Remove a single key from the cache (best-effort).
     */
    void invalidate(const std::string& key)
    {
        try
        {
            _redis.del(key);
        }
        catch (const sw::redis::Error& ex)
        {
            throw CacheError{"Redis DEL failed: " + std::string{ex.what()}};
        }
    }

    /**
     * Flush the whole Redis DB connected to by this instance.
     * Use with caution – mainly meant for test suites or administrative tooling.
     */
    void flush()
    {
        try
        {
            _redis.flushdb();
        }
        catch (const sw::redis::Error& ex)
        {
            throw CacheError{"Redis FLUSHDB failed: " + std::string{ex.what()}};
        }
    }

private:
    // SERIALIZATION  ---------------------------------------------------------

    /**
     * Serialize arbitrary types to a string using one of two strategies:
     *   • If the type is std::string or C-string convertible, store as-is.
     *   • Else: attempt nlohmann::json serialization.
     */
    template <typename T>
    static std::string serialize(const T& value)
    {
        if constexpr (std::is_same_v<T, std::string>)
        {
            return value;
        }
        else if constexpr (std::is_same_v<T, char*> ||
                           std::is_same_v<T, const char*>)
        {
            return std::string{value};
        }
        else
        {
            // Leveraging ADL ‑ relies on to_json/from_json specializations or
            // nlohmann::json default conversions for fundamental/container types.
            nlohmann::json j = value;
            return j.dump();
        }
    }

    /**
     * Reverse operation of serialize().
     */
    template <typename T>
    static T deserialize(const std::string& blob)
    {
        if constexpr (std::is_same_v<T, std::string>)
        {
            return blob;
        }
        else
        {
            nlohmann::json j = nlohmann::json::parse(blob);
            return j.get<T>();
        }
    }

    // MEMBERS  ---------------------------------------------------------------

    sw::redis::Redis             _redis;
    std::chrono::milliseconds    _default_ttl;
};

}  // namespace chrono_flow::infra::caching