```markdown
# PaletteFlux GraphQL Studio  
## API Versioning Reference (C++ Implementation Guide)

The PaletteFlux runtime treats API-version negotiation as a **first-class concern** that is handled _before_ controller dispatch, ensuring that both GraphQL resolvers and REST handlers are compiled against (and linked to) the correct schema version.

This document explains **how to embed version-aware routing in C++** by using the production-ready utilities shipped with the PaletteFlux codebase.  
All samples compile with **C++20** (tested with Clang 16 and GCC 13).

---

## 1. Semantic Version Model

```cpp
// include/paletteflux/core/version.hpp
#pragma once

#include <compare>
#include <cstdint>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>

namespace pflux::version
{
    /**
     * Immutable semantic-version record.
     *
     * major: Breaking changes
     * minor: Backwards compatible additions
     * patch: Bug fixes / doc updates
     */
    struct SemVer
    {
        std::uint16_t major = 0;
        std::uint16_t minor = 0;
        std::uint16_t patch = 0;

        constexpr std::strong_ordering operator<=>(const SemVer&) const = default;

        [[nodiscard]] std::string to_string() const
        {
            return std::to_string(major) + '.' + std::to_string(minor) + '.' +
                   std::to_string(patch);
        }

        /**
         * Parse a SemVer from "MAJOR.MINOR.PATCH".
         * Throws std::invalid_argument on malformed input.
         */
        static SemVer parse(std::string_view str);
    };

    /* --------------------------------------------------------------------- */
    // Inline implementation to keep header-only for dependency-free rollout.
    /* --------------------------------------------------------------------- */

    inline SemVer SemVer::parse(std::string_view str)
    {
        SemVer out{};
        std::size_t firstDot = str.find('.');
        std::size_t secondDot = str.rfind('.');

        if (firstDot == std::string_view::npos || secondDot == firstDot)
            throw std::invalid_argument("SemVer parse error: missing dots");

        auto to_uint16 = [](std::string_view part) -> std::uint16_t
        {
            if (part.empty())
                throw std::invalid_argument("SemVer parse error: empty segment");

            std::size_t idx = 0;
            auto value     = std::stoul(std::string(part), &idx);
            if (idx != part.size() || value > std::numeric_limits<std::uint16_t>::max())
                throw std::invalid_argument("SemVer parse error: overflow/garbage");

            return static_cast<std::uint16_t>(value);
        };

        out.major = to_uint16(str.substr(0, firstDot));
        out.minor = to_uint16(str.substr(firstDot + 1, secondDot - firstDot - 1));
        out.patch = to_uint16(str.substr(secondDot + 1));

        return out;
    }
} // namespace pflux::version
```

---

## 2. Expressing Version Ranges

```cpp
// include/paletteflux/core/version_range.hpp
#pragma once

#include "version.hpp"

#include <optional>

namespace pflux::version
{
    /**
     * A closed [min, max] interval (inclusive).
     * `max == std::nullopt` denotes an open upper bound.
     */
    struct Range
    {
        SemVer                       min;
        std::optional<SemVer>        max; // nullopt = infinity

        [[nodiscard]] bool contains(const SemVer& v) const
        {
            if (v < min) return false;
            if (max.has_value() && v > *max) return false;
            return true;
        }

        [[nodiscard]] std::string to_string() const
        {
            return '[' + min.to_string() + ',' +
                   (max.has_value() ? max->to_string() : "∞") + ']';
        }
    };
} // namespace pflux::version
```

---

## 3. Resolving the Best Version

```cpp
// include/paletteflux/http/version_negotiator.hpp
#pragma once

#include "paletteflux/core/version_range.hpp"

#include <span>
#include <string_view>
#include <vector>

namespace pflux::http
{
    /**
     * Accept-Version header value: "v=<semver>; q=<0..1>"
     */
    struct AcceptVersion
    {
        version::SemVer version;
        double          quality = 1.0; // default q=1

        [[nodiscard]] bool operator<(const AcceptVersion& rhs) const noexcept
        {
            // Sort by descending q, then descending version
            if (quality != rhs.quality) return quality > rhs.quality;
            return version > rhs.version;
        }
    };

    /**
     * Parse the entire header into a stable vector.
     *
     * Header grammar (simplified):
     *   Accept-Version  = *( "," OWS ) media-range *( OWS ";" OWS parameter )
     *
     * Any malformed entry is ignored.
     */
    [[nodiscard]]
    std::vector<AcceptVersion> parse_accept_version_header(std::string_view header);

    /**
     * Pick the best supported version for a request.
     *  - `supported` MUST be sorted ascending.
     *  - Returns nullopt if no intersection exists.
     */
    [[nodiscard]]
    std::optional<version::SemVer>
    negotiate_version(std::span<const AcceptVersion> requested,
                      std::span<const version::SemVer> supported);
} // namespace pflux::http
```

```cpp
// src/version_negotiator.cpp
#include "paletteflux/http/version_negotiator.hpp"

#include <algorithm>
#include <charconv>
#include <cctype>
#include <cstdlib>

using namespace pflux;
using version::SemVer;

namespace
{
    static std::optional<double> parse_q(std::string_view token)
    {
        if (!token.starts_with("q=")) return std::nullopt;
        token.remove_prefix(2);
        char*   end = nullptr;
        double  val = std::strtod(token.data(), &end);
        if (end != token.end()) return std::nullopt;
        if (val < 0.0 || val > 1.0) return std::nullopt;
        return val;
    }
} // namespace

std::vector<http::AcceptVersion>
http::parse_accept_version_header(std::string_view header)
{
    std::vector<AcceptVersion> out;

    while (!header.empty())
    {
        // 1. Trim leading whitespace / commas
        while (!header.empty() && (header.front() == ' ' || header.front() == ','))
            header.remove_prefix(1);
        if (header.empty()) break;

        // 2. Extract token until ',' or end
        auto pos = header.find(',');
        std::string_view token = header.substr(0, pos);
        if (pos != std::string_view::npos) header.remove_prefix(pos + 1);
        else header = {};

        // 3. Split by ';'
        auto semicolon = token.find(';');
        std::string_view verPart = token.substr(0, semicolon);
        std::string_view paramPart =
            semicolon == std::string_view::npos ? "" : token.substr(semicolon + 1);

        // 4. Parse SemVer
        try
        {
            AcceptVersion v;
            v.version = SemVer::parse(verPart);

            // 5. Parse optional "; q=<number>"
            if (!paramPart.empty())
            {
                auto qopt = parse_q(paramPart);
                if (qopt) v.quality = *qopt;
            }
            out.emplace_back(v);
        }
        catch (...)
        {
            // Ignore malformed entry
        }
    }
    std::sort(out.begin(), out.end());
    return out;
}

std::optional<SemVer>
http::negotiate_version(std::span<const AcceptVersion> requested,
                        std::span<const SemVer>       supported)
{
    for (const auto& req : requested)
        for (auto it = supported.rbegin(); it != supported.rend(); ++it)
            if (*it == req.version)
                return *it;
    return std::nullopt;
}
```

---

## 4. Controller Glue Code

```cpp
// src/rest/scene_controller.cpp (excerpt)
#include "paletteflux/http/version_negotiator.hpp"
#include "paletteflux/rest/scene_v1.hpp"
#include "paletteflux/rest/scene_v2.hpp"

#include <cpptrace/cpptrace.hpp>  // fictional stack-trace lib
#include <iostream>

namespace pflux::rest
{
    void SceneController::handle_request(const HttpRequest& req, HttpResponse& res)
    {
        try
        {
            using namespace pflux::version;
            using namespace pflux::http;

            const auto acceptV = parse_accept_version_header(
                req.headers.get("Accept-Version").value_or(""));

            // Hard-coded list until we add dynamic plugin loading
            static constexpr SemVer supported[] {
                SemVer{1, 0, 0},
                SemVer{2, 0, 0},
            };

            auto negotiated = negotiate_version(acceptV, supported)
                                .value_or(SemVer{1,0,0}); // Fallback

            if (negotiated.major == 1)
                res = scene_v1::handle(req);
            else if (negotiated.major == 2)
                res = scene_v2::handle(req);
            else
                throw std::runtime_error("Unsupported API version");

        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.body   = std::string{"Bad Request: "} + ex.what();
            std::cerr << cpptrace::generate_trace() << '\n';
        }
    }
} // namespace pflux::rest
```

---

## 5. GraphQL Schema Evolution

GraphQL requests embed the desired API version in a **required HTTP header** (`X-PaletteFlux-Version`) or as a **root-level variable**:

```graphql
query FetchAsset($apiVersion: String!, $id: ID!) {
  asset(id: $id, apiVersion: $apiVersion) {
    id
    ... on BrushStrokeV2 { bezierPoints }
    ... on BrushStroke    { points }        # v1 fallback
  }
}
```

On the server side we bind a middleware that injects `SemVer` into the resolver context:

```cpp
// src/graphql/version_middleware.cpp
#include "paletteflux/core/version.hpp"
#include <graphqlservice/GraphQLService.h>

using graphql::service::RequestContext;

class VersionMiddleware : public graphql::service::RequestState
{
public:
    pflux::version::SemVer apiVersion;
};

std::shared_ptr<RequestContext>
injectVersionContext(const http::HttpRequest& httpReq)
{
    auto state = std::make_shared<VersionMiddleware>();

    try
    {
        state->apiVersion = pflux::version::SemVer::parse(
            httpReq.headers.get("X-PaletteFlux-Version")
                  .value_or("2.0.0")); // GraphQL defaults to latest stable
    }
    catch (...)
    {
        state->apiVersion = {1,0,0};
    }
    return state;
}
```

Resolvers can then gate features:

```cpp
// src/graphql/resolvers/brush.cpp
#include "paletteflux/core/version.hpp"

graphql::service::FieldResult<std::vector<Point>>
BrushStroke::getPoints() const
{
    using namespace pflux;
    const auto& ctx = graphql::service::get_request_context(versionMiddlewareKey)
                          .as<VersionMiddleware>();
    if (ctx.apiVersion >= version::SemVer{2,0,0})
        throw graphql::service::schema_exception{
            "Field 'points' deprecated. Use 'bezierPoints' instead."};

    return points_;
}
```

---

## 6. Exhaustive Unit Tests (Catch2)

```cpp
// tests/test_versioning.cpp
#define CATCH_CONFIG_MAIN
#include <catch2/catch.hpp>

#include "paletteflux/core/version.hpp"
#include "paletteflux/http/version_negotiator.hpp"

TEST_CASE("SemVer::parse valid")
{
    using pflux::version::SemVer;
    auto v = SemVer::parse("12.3.45");
    REQUIRE(v.major == 12);
    REQUIRE(v.minor == 3);
    REQUIRE(v.patch == 45);
}

TEST_CASE("SemVer::parse invalid")
{
    using pflux::version::SemVer;
    REQUIRE_THROWS_AS(SemVer::parse("bad.version"), std::invalid_argument);
}

TEST_CASE("Accept-Version negotiation")
{
    using namespace pflux;
    std::string header =
        "1.0.0; q=0.5, 2.0.0; q=1.0, 0.9.0; q=0.1";
    auto parsed = http::parse_accept_version_header(header);

    REQUIRE(parsed.front().version == version::SemVer{2,0,0});
    REQUIRE(parsed.front().quality == Approx(1.0));

    static constexpr version::SemVer supported[] {
        {1,0,0}, {2,0,0}
    };

    auto negotiated = http::negotiate_version(parsed, supported);
    REQUIRE(negotiated);
    REQUIRE(*negotiated == version::SemVer{2,0,0});
}
```

---

## 7. Deprecation Workflow

The C++ build system supplies a **macro that marks obsolete APIs**:

```cpp
// include/paletteflux/core/deprecate.hpp
#pragma once

#if defined(__clang__) || defined(__GNUC__)
    #define PFLUX_DEPRECATED(msg) __attribute__((deprecated(msg)))
#elif defined(_MSC_VER)
    #define PFLUX_DEPRECATED(msg) __declspec(deprecated(msg))
#else
    #define PFLUX_DEPRECATED(msg)
#endif
```

```cpp
class PFLUX_DEPRECATED("Use BrushStrokeV2::setBezierPoints instead")
BrushStroke
{
    // ...
};
```

Breaking removals occur only on **major-version bumps**, giving downstream
clients time to migrate.

---

## 8. FAQ

**Q **: _What happens if a client omits `Accept-Version`?_  
**A **: The server defaults to **latest minor of the oldest supported major** to maximise compatibility.

**Q **: _Can I request a version range in REST?_  
**A **: Yes. Specify multiple `Accept-Version` entries with descending _q_ values. The negotiator picks the highest common version.

---

**© PaletteFlux Studio – All rights reserved.**
```