```cpp
#pragma once
/**
 *  PaletteFlux GraphQL Studio
 *  File: paletteflux_studio/src/rendering/JsonRenderer.h
 *
 *  Description:
 *      JsonRenderer is a lightweight, thread-safe façade around the JSON
 *      serialization facilities used by PaletteFlux' REST and GraphQL layers.
 *      It encapsulates global rendering options (pretty-print, schema version,
 *      null-filtering, etc.), helpers for error/document envelopes, and a small
 *      utility toolbox (ETag calculation, ISO-8601 timestamps, pagination
 *      cursors).  Domain objects are expected to provide a `void to_json(...)`
 *      free-standing function or a compatible `json()` member.  Because the
 *      class is header-only (template heavy), it imposes no additional linking
 *      constraints and can safely live in shared libraries.
 *
 *  Usage:
 *      JsonRenderer renderer{ JsonRenderer::Options{}.prettyPrint(true) };
 *      const auto payload = renderer.render(userDto);
 *      const auto body    = renderer.stringify(payload);
 *
 *  Copyright:
 *      MIT-licensed — 2023-present PaletteFlux Contributors.
 */

#include <chrono>
#include <cstdint>
#include <functional>
#include <iomanip>
#include <mutex>
#include <sstream>
#include <string>
#include <type_traits>
#include <utility>

#include <nlohmann/json.hpp>                // External dependency (single-header)

//------------------------------------------------------------------------------

namespace paletteflux::studio::rendering
{

using json = ::nlohmann::json;

//------------------------------------------------------------------------------
// JsonRenderer
//------------------------------------------------------------------------------

class JsonRenderer
{
public:
    //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    // Compile-time helpers
    //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

    /// Detect whether T has a to_json specialization in the chosen json lib.
    template <typename, typename = void>
    struct has_nlohmann_to_json : std::false_type
    {
    };

    template <typename T>
    struct has_nlohmann_to_json<
        T,
        std::void_t<
            decltype(to_json(std::declval<json&>(), std::declval<const T&>()))>>
        : std::true_type
    {
    };

    //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    // Options
    //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

    struct Options
    {
        bool enablePrettyPrint = false;          // Indent output?
        bool emitNullValues    = false;          // Keep null / missing fields
        std::uint32_t apiSchemaVersion = 1;      // Bump when breaking changes
        std::string dateTimeFormat = "%FT%TZ";   // ISO-8601 by default
        bool sortKeysAlphabetically = true;      // Deterministic output

        // Fluent-style mutators for convenience
        Options& prettyPrint(bool v) noexcept { enablePrettyPrint = v; return *this; }
        Options& showNulls(bool v)    noexcept { emitNullValues    = v; return *this; }
        Options& version(std::uint32_t v) noexcept { apiSchemaVersion = v; return *this; }
        Options& dateFormat(std::string fmt)
        { dateTimeFormat = std::move(fmt); return *this; }
        Options& sortKeys(bool v) noexcept { sortKeysAlphabetically = v; return *this; }
    };

    //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    // Construction
    //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

    explicit JsonRenderer(Options opts = {}) : _options(std::move(opts)) {}

    // non-movable / non-copyable intentionally — renderer is cheap to construct
    JsonRenderer(const JsonRenderer&)            = delete;
    JsonRenderer& operator=(const JsonRenderer&) = delete;

    //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    // Primary API
    //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

    /**
     * Render an arbitrary DTO/model object to JSON using ADL-discovered
     * `to_json(nlohmann::json&, const T&)`.  Compilation will break if such
     * overload cannot be found for the supplied type.
     */
    template <typename T>
    [[nodiscard]] json render(const T& object) const
    {
        static_assert(
            has_nlohmann_to_json<T>::value,
            "No compatible to_json overload detected for supplied type.");

        json j;
        to_json(j, object);               // ADL call
        postProcessJson(j);
        applyMetaEnvelope(j);
        return j;
    }

    /**
     * Render an error response according to PaletteFlux' error contract:
     *
     * {
     *     "errors": [
     *        { "code": "...", "message": "...", "details": {...} }
     *     ]
     * }
     */
    [[nodiscard]] json renderError(const std::string& code,
                                   const std::string& message,
                                   json details = {}) const
    {
        json err = {
            { "code",    code     },
            { "message", message  }
        };

        if (!details.empty())
            err["details"] = std::move(details);

        json root;
        root["errors"] = json::array({ std::move(err) });
        applyMetaEnvelope(root);
        return root;
    }

    /**
     * Convert JSON into a string obeying renderer options (indentation, key
     * ordering, etc.).  Expensive operations are protected by a lock given
     * that nlohmann/json is *not* thread-safe for concurrent writes.
     */
    [[nodiscard]] std::string stringify(const json& j) const
    {
        std::lock_guard lock(_mutex);

        json copy = j;
        if (_options.sortKeysAlphabetically)
            copy = sortRecursively(copy);

        constexpr auto indentStep = 2;  // Spaces
        return _options.enablePrettyPrint
            ? copy.dump(indentStep)
            : copy.dump();
    }

    /**
     *  Utility: compute weak ETag (SHA-1 based) for caching headers.
     *  Implementation is micro-optimised for small / medium JSON payloads.
     */
    [[nodiscard]] std::string weakEtag(const json& j) const
    {
        // Very small, header-only SHA-1 implementation for demonstration.
        // In production, wire in a vetted library (OpenSSL / Botan / libsodium).
        // --------------------------------------------------------------------
        struct Sha1
        {
            std::uint32_t h[5]{ 0x67452301u, 0xEFCDAB89u, 0x98BADCFEu,
                                0x10325476u, 0xC3D2E1F0u };

            static constexpr auto leftRotate(std::uint32_t value, int count) {
                return (value << count) | (value >> (32 - count));
            }

            void process(const unsigned char* data, std::size_t len)
            {
                std::uint64_t bitlen = len * 8;
                std::size_t i = 0;

                unsigned char block[64]{};
                while (i + 64 <= len) {
                    std::memcpy(block, data + i, 64);
                    transform(block);
                    i += 64;
                }
                // Padding
                std::size_t remain = len - i;
                std::memcpy(block, data + i, remain);
                block[remain] = 0x80;

                if (remain >= 56) {
                    transform(block);
                    std::memset(block, 0, 64);
                }
                for (int j = 7; j >= 0; --j) {
                    block[56 + j] = static_cast<unsigned char>(bitlen & 0xFF);
                    bitlen >>= 8;
                }
                transform(block);
            }

            void transform(const unsigned char* chunk)
            {
                std::uint32_t w[80]{};
                for (std::size_t i = 0; i < 16; ++i) {
                    w[i] =  (static_cast<std::uint32_t>(chunk[i * 4    ]) << 24)
                          | (static_cast<std::uint32_t>(chunk[i * 4 + 1]) << 16)
                          | (static_cast<std::uint32_t>(chunk[i * 4 + 2]) <<  8)
                          |  static_cast<std::uint32_t>(chunk[i * 4 + 3]);
                }
                for (std::size_t i = 16; i < 80; ++i)
                    w[i] = leftRotate(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

                std::uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];

                for (std::size_t i = 0; i < 80; ++i) {
                    auto f = (i < 20)  ? ((b & c) | ((~b) & d))
                           : (i < 40)  ? (b ^ c ^ d)
                           : (i < 60)  ? ((b & c) | (b & d) | (c & d))
                                       : (b ^ c ^ d);

                    auto k = (i < 20)  ? 0x5A827999u
                           : (i < 40)  ? 0x6ED9EBA1u
                           : (i < 60)  ? 0x8F1BBCDCu
                                       : 0xCA62C1D6u;

                    auto temp = leftRotate(a, 5) + f + e + k + w[i];
                    e = d;
                    d = c;
                    c = leftRotate(b, 30);
                    b = a;
                    a = temp;
                }
                h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
            }

            [[nodiscard]] std::string toHex() const
            {
                std::ostringstream oss;
                oss << std::hex << std::setfill('0');
                for (auto v : h) oss << std::setw(8) << v;
                return oss.str();
            }
        };

        const auto dump = j.dump();  // no pretty print
        Sha1 sha1;
        sha1.process(
            reinterpret_cast<const unsigned char*>(dump.data()),
            dump.size());
        return "W/\"" + sha1.toHex() + "\"";
    }

    //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    // Misc helpers (public)
    //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

    [[nodiscard]] std::string isoTimestamp() const
    {
        using clock = std::chrono::system_clock;
        const auto now = clock::now();
        const auto t   = clock::to_time_t(now);

        std::tm tm{};
#if defined(_WIN32)
        gmtime_s(&tm, &t);
#else
        gmtime_r(&t, &tm);
#endif
        std::ostringstream oss;
        oss << std::put_time(&tm, _options.dateTimeFormat.c_str());
        return oss.str();
    }

    [[nodiscard]] const Options& options() const noexcept { return _options; }

private:
    Options          _options;
    mutable std::mutex _mutex;  // guards stringify() & other stateful helpers

    //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    // Internal helpers
    //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

    void applyMetaEnvelope(json& j) const
    {
        if (!j.is_object()) return;

        j["$meta"] = {
            { "schemaVersion", _options.apiSchemaVersion },
            { "generatedAt",   isoTimestamp()            }
        };
    }

    static json sortRecursively(json j)
    {
        if (j.is_object()) {
            json sorted(json::value_t::object);
            auto keys = j.get<std::map<std::string, json>>();
            for (auto& [k, v] : keys)
                sorted[k] = sortRecursively(v);
            return sorted;
        }
        if (j.is_array()) {
            for (auto& el : j)
                el = sortRecursively(el);
        }
        return j;
    }

    // Post-processing step executed after user-provided to_json() completes.
    void postProcessJson(json& j) const
    {
        if (!_options.emitNullValues) {
            removeNullsRecursively(j);
        }
    }

    static void removeNullsRecursively(json& j)
    {
        if (j.is_object()) {
            for (auto it = j.begin(); it != j.end(); /* no increment */) {
                if (it->is_null()) {
                    it = j.erase(it);
                    continue;
                }
                removeNullsRecursively(*it);
                ++it;
            }
        } else if (j.is_array()) {
            for (auto& el : j)
                removeNullsRecursively(el);
        }
    }
};

} // namespace paletteflux::studio::rendering
```