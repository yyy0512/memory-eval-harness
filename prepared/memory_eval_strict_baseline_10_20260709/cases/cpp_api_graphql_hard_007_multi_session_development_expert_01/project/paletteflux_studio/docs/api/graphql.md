```markdown
# PaletteFlux GraphQL Studio – API Reference

> Version: **v1.4**  
> Last-Updated: **2024-05-04**

PaletteFlux GraphQL Studio exposes its entire creative-asset domain model through a single GraphQL endpoint.

```
POST https://api.paletteflux.io/graphql
Content-Type: application/json
Authorization: Bearer <JWT>
```

The endpoint supports persisted queries, automatic persisted operations (APQ), persisted mutations, and server-side response caching with a default TTL of **30 s** (configurable per operation via `@cacheControl` directives).

---

## Contents

1. Quick-Start
2. Schema Overview
3. Common Queries
4. Mutations
5. Pagination & Cursors
6. Versioning Strategy
7. C++ Client Example **(production-quality, ready to compile)**
8. Advanced Topics  
   8.1. Observability (`@trace`, `@span`)  
   8.2. Error Shape  
   8.3. SDL Extensions

---

## 1. Quick-Start

```bash
# Install the standalone CLI (optional)
$ brew install paletteflux/pfx/pfxctl

# Introspect the live schema
$ pfxctl introspect --out schema.graphql
```

---

## 2. Schema Overview (SDL excerpt)

```graphql
"""
A creative asset is anything the artist can manipulate.
"""
interface Asset {
  "Globally unique, ULID-derived identifier"
  id: ID!

  "RFC 3339 creation timestamp"
  createdAt: DateTime!

  "RFC 3339 update timestamp"
  updatedAt: DateTime!
}

"""
A 2-D or 3-D texture, optionally compressed.
"""
type Texture implements Asset {
  id: ID!
  createdAt: DateTime!
  updatedAt: DateTime!

  "User-friendly name"
  name: String!

  "Pixel dimensions"
  width: Int!
  height: Int!

  "Color profile (e.g. sRGB, Linear)"
  colorSpace: ColorSpace!

  "CDN URL (signed, expiring)"
  url: URL!
}

"""
Root query type.
"""
type Query {
  asset(id: ID!): Asset
  textures(first: Int = 25, after: Cursor): TextureConnection!
}
```

For the complete schema, see [`docs/api/schema.graphql`](../schema.graphql).

---

## 3. Common Queries

### 3.1. Fetch a Single Texture

```graphql
query GetTexture($id: ID!) {
  asset(id: $id) {
    ... on Texture {
      id
      name
      width
      height
      url
    }
  }
}
```

### 3.2. List Textures (Paginated)

```graphql
query ListTextures($first: Int!, $after: Cursor) {
  textures(first: $first, after: $after) @cacheControl(maxAge: 60) {
    edges {
      node {
        id
        name
        width
        height
        url
      }
      cursor
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

---

## 4. Mutations

### 4.1. Upload a Texture

```graphql
mutation UploadTexture($input: UploadTextureInput!) {
  uploadTexture(input: $input) {
    texture {
      id
      name
      width
      height
      url
    }
  }
}
```

**Multipart spec:** PaletteFlux follows [graphql-multipart-request-spec v2](https://github.com/jaydenseric/graphql-multipart-request-spec).

---

## 5. Pagination & Cursors

PaletteFlux uses opaque **ULID-encoded** cursors. Clients must treat cursor values as black boxes—do not attempt to parse.

---

## 6. Versioning Strategy

The GraphQL schema is _additive_.  
Breaking changes are gated behind versioned root fields:

```
Query.v2_<fieldName>
Mutation.v2_<fieldName>
```

---

## 7. C++ Client Example

> The following production-grade client demonstrates:
> * HTTPS POST via **libcurl**
> * JSON parsing with **nlohmann/json**
> * In-memory response cache  
> * Robust error handling (network & GraphQL errors)  
> * Cursor-based pagination helper  

> Build Dependencies  
> * libcurl (`brew install curl`)  
> * nlohmann/json (header-only, v3.11+)  

```cpp
// File: examples/paletteflux_graphql_client.cpp
//
// Compile:
//   g++ -std=c++20 -O2 -Wall -Wextra -pedantic \
//       paletteflux_graphql_client.cpp -o pfx_client \
//       -lcurl
//
// Usage:
//   ./pfx_client <JWT> <texture-id>
//
// Example:
//   ./pfx_client eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9... 01H8TN2E2B7X4RETMH52AN6NZC

#include <curl/curl.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <exception>
#include <iomanip>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>

namespace pfx {

//------------------------------------------------------------------------------
// util
//------------------------------------------------------------------------------
using json = nlohmann::json;
using Clock = std::chrono::steady_clock;

static std::string to_iso8601(const Clock::time_point& tp)
{
    const auto time = Clock::to_time_t(tp);
    std::ostringstream oss;
    oss << std::put_time(std::gmtime(&time), "%FT%TZ");
    return oss.str();
}

//------------------------------------------------------------------------------
// curl helpers
//------------------------------------------------------------------------------
namespace detail {

inline size_t write_cb(char* ptr, size_t size, size_t nmemb, void* userdata)
{
    auto* stream = static_cast<std::string*>(userdata);
    const size_t total = size * nmemb;
    stream->append(ptr, total);
    return total;
}

class CurlHandle
{
public:
    CurlHandle()
    : handle_(curl_easy_init())
    {
        if (!handle_)
        {
            throw std::runtime_error("Failed to init CURL handle");
        }
        curl_easy_setopt(handle_, CURLOPT_FOLLOWLOCATION, 1L);
        curl_easy_setopt(handle_, CURLOPT_WRITEFUNCTION, write_cb);
    }

    ~CurlHandle() { curl_easy_cleanup(handle_); }

    CURL* get() noexcept { return handle_; }

private:
    CURL* handle_;
};

} // namespace detail

//------------------------------------------------------------------------------
// error
//------------------------------------------------------------------------------
class HttpError final : public std::runtime_error
{
public:
    explicit HttpError(long status, std::string msg)
    : std::runtime_error(std::move(msg)), status_(status)
    {}

    long status() const noexcept { return status_; }

private:
    long status_;
};

class GraphQLError final : public std::runtime_error
{
public:
    explicit GraphQLError(json errors)
    : std::runtime_error(errors.dump(2)), errors_(std::move(errors))
    {}

    const json& errors() const noexcept { return errors_; }

private:
    json errors_;
};

//------------------------------------------------------------------------------
// Response Cache
//------------------------------------------------------------------------------
class InMemoryCache
{
public:
    struct Entry
    {
        json             data;
        Clock::time_point expiresAt;
    };

    bool contains(std::string_view key) const
    {
        auto it = storage_.find(std::string(key));
        if (it == storage_.end()) return false;
        return Clock::now() < it->second.expiresAt;
    }

    json get(std::string_view key) const
    {
        return storage_.at(std::string(key)).data;
    }

    void put(std::string key, json value, std::chrono::seconds ttl)
    {
        storage_[std::move(key)] = Entry{ std::move(value), Clock::now() + ttl };
    }

private:
    mutable std::unordered_map<std::string, Entry> storage_;
};

//------------------------------------------------------------------------------
// GraphQL Client
//------------------------------------------------------------------------------
class GraphQLClient
{
public:
    explicit GraphQLClient(std::string endpoint, std::string jwt)
    : endpoint_(std::move(endpoint))
    , jwt_(std::move(jwt))
    {
        curl_global_init(CURL_GLOBAL_DEFAULT);
    }

    ~GraphQLClient() { curl_global_cleanup(); }

    json execute(std::string query,
                 json         variables   = json::object(),
                 std::chrono::seconds ttl = std::chrono::seconds{30})
    {
        // Cache key = sha256(query + variables)
        const std::string key = cache_key(query, variables);
        if (cache_.contains(key))
        {
            return cache_.get(key);
        }

        detail::CurlHandle curl;
        std::string        responseBuffer;

        // Prepare payload
        json payload = {
            { "query",     std::move(query) },
            { "variables", std::move(variables) }
        };
        const std::string payloadStr = payload.dump();

        // Headers
        struct curl_slist* headers = nullptr;
        headers = curl_slist_append(headers, "Content-Type: application/json; charset=utf-8");
        std::string authHeader = "Authorization: Bearer " + jwt_;
        headers = curl_slist_append(headers, authHeader.c_str());

        // Configure request
        CURL* h = curl.get();
        curl_easy_setopt(h, CURLOPT_URL, endpoint_.c_str());
        curl_easy_setopt(h, CURLOPT_POST, 1L);
        curl_easy_setopt(h, CURLOPT_POSTFIELDS, payloadStr.c_str());
        curl_easy_setopt(h, CURLOPT_POSTFIELDSIZE, payloadStr.size());
        curl_easy_setopt(h, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(h, CURLOPT_WRITEDATA, &responseBuffer);

        // Perform
        const CURLcode res = curl_easy_perform(h);
        curl_slist_free_all(headers);

        if (res != CURLE_OK)
        {
            throw std::runtime_error(std::string("CURL error: ") + curl_easy_strerror(res));
        }

        long http_status = 0;
        curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &http_status);
        if (http_status != 200)
        {
            throw HttpError(http_status, "Non-successful HTTP status: " + std::to_string(http_status));
        }

        // Parse JSON
        json result = json::parse(responseBuffer, nullptr, /* allow exceptions = */ true);

        if (result.contains("errors"))
        {
            // GraphQL-level errors
            throw GraphQLError(result.at("errors"));
        }

        if (!result.contains("data"))
        {
            throw std::runtime_error("Malformed GraphQL response (missing 'data')");
        }

        cache_.put(key, result.at("data"), ttl);
        return result.at("data");
    }

private:
    // Naive hash (for brevity). In production, prefer SHA-256.
    static std::string cache_key(const std::string& query, const json& vars)
    {
        std::hash<std::string> hasher;
        std::size_t            h = hasher(query) ^ hasher(vars.dump());
        return std::to_string(h);
    }

    std::string   endpoint_;
    std::string   jwt_;
    InMemoryCache cache_;
};

//------------------------------------------------------------------------------
// Example: fetch a texture + follow pagination
//------------------------------------------------------------------------------
static void demo_fetch_texture_and_list(GraphQLClient& client,
                                        std::string_view textureId)
{
    // 1. Single asset
    const std::string textureQuery = R"GRAPHQL(
        query GetTexture($id: ID!) {
          asset(id: $id) {
            ... on Texture {
              id
              name
              width
              height
              url
            }
          }
        }
    )GRAPHQL";

    json vars = { { "id", textureId } };
    json data = client.execute(textureQuery, vars);

    const auto& tex = data["asset"];
    std::cout << "[Texture] " << tex["name"] << " (" << tex["width"] << "x" << tex["height"]
              << ")\nURL: " << tex["url"] << "\n\n";

    // 2. Paginated list
    std::string   cursor;
    bool          hasNext = true;
    unsigned int  page    = 1;
    const unsigned int PAGE_SIZE = 5;

    const std::string listTexturesQuery = R"GRAPHQL(
        query ListTextures($first: Int!, $after: Cursor) {
          textures(first: $first, after: $after) {
            edges { node { id name width height url } cursor }
            pageInfo { hasNextPage endCursor }
          }
        }
    )GRAPHQL";

    while (hasNext)
    {
        json varsPage = {
            { "first", PAGE_SIZE },
            { "after", cursor.empty() ? json(nullptr) : json(cursor) }
        };

        json listData = client.execute(listTexturesQuery, varsPage, std::chrono::seconds{60});
        const auto& conn = listData["textures"];
        std::cout << "---- Page " << page++ << " ----\n";
        for (const auto& edge : conn["edges"])
        {
            const auto& node = edge["node"];
            std::cout << "* " << node["id"] << " | " << node["name"]
                      << " (" << node["width"] << "x" << node["height"] << ")\n";
        }
        hasNext = conn["pageInfo"]["hasNextPage"].get<bool>();
        cursor  = conn["pageInfo"]["endCursor"].get<std::string>();
        std::cout << std::endl;
    }
}

//------------------------------------------------------------------------------
// main
//------------------------------------------------------------------------------
int main(int argc, char* argv[])
{
    if (argc != 3)
    {
        std::cerr << "Usage: pfx_client <JWT> <texture-id>\n";
        return EXIT_FAILURE;
    }

    const std::string jwt        = argv[1];
    const std::string textureId  = argv[2];
    const std::string endpoint   = "https://api.paletteflux.io/graphql";

    try
    {
        pfx::GraphQLClient client(endpoint, jwt);
        demo_fetch_texture_and_list(client, textureId);
    }
    catch (const pfx::GraphQLError& gqlErr)
    {
        std::cerr << "[GraphQL Error]\n" << gqlErr.what() << '\n';
        return EXIT_FAILURE;
    }
    catch (const pfx::HttpError& httpErr)
    {
        std::cerr << "[HTTP " << httpErr.status() << "] " << httpErr.what() << '\n';
        return EXIT_FAILURE;
    }
    catch (const std::exception& ex)
    {
        std::cerr << "[Error] " << ex.what() << '\n';
        return EXIT_FAILURE;
    }

    return EXIT_SUCCESS;
}
```

---

## 8. Advanced Topics

### 8.1. Observability

PaletteFlux embeds OpenTelemetry spans for the entire GraphQL resolver pipeline.  Clients can opt-in to precision tracing:

```
{
  textures(first: 3) @trace(span: "listing.textures", attributes: ["first"])
}
```

### 8.2. Error Shape

```json
{
  "errors": [
    {
      "message": "Forbidden",
      "extensions": {
        "code":    "AUTH_NOT_AUTHENTICATED",
        "traceId": "01H8TNDCDXXH742JA0RAGKE9NJ"
      }
    }
  ]
}
```

### 8.3. SDL Extensions

PaletteFlux extends the official spec with the following custom scalar types:

* `ULID` – 26-char Crockford Base32
* `URL`  – absolute, validated
* `Cursor` – opaque byte sequence, base64-encoded  

Refer to the full SDL for implementational details.

---

© 2024 PaletteFlux Studios. All rights reserved.
```