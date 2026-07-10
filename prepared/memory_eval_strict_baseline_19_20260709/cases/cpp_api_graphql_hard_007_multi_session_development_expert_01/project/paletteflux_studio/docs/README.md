```markdown
# PaletteFlux GraphQL Studio – C++ Reference Client
Welcome to the **PaletteFlux GraphQL Studio** C++ reference client!  
This guide walks you through:

* Building the client with **CMake**  
* Issuing **GraphQL** queries & mutations  
* Consuming **REST** snapshots for cache-friendly delivery  
* Handling pagination, timeouts, and structured errors  

All sample source files are self-contained and compile on **Linux / macOS / Windows** with **C++17**.

---

## 1. Getting the Source

```bash
git clone https://github.com/PaletteFlux/api_graphql.git
cd api_graphql/clients/cpp
```

---

## 2. Building with CMake

```bash
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
cmake --build . --config Release
./paletteflux_cli --help
```

Dependencies are automatically pulled in via **FetchContent**:

* [libcurl](https://curl.se/libcurl/) – HTTP transport  
* [nlohmann/json](https://github.com/nlohmann/json) – JSON handling  
* [fmt](https://github.com/fmtlib/fmt) – type-safe string formatting  

---

## 3. Source Layout

```
cpp/
 ├── CMakeLists.txt
 ├── include/
 │   ├── pf_client/GraphQLClient.hpp
 │   ├── pf_client/RestClient.hpp
 │   └── pf_client/exceptions.hpp
 └── src/
     ├── GraphQLClient.cpp
     ├── RestClient.cpp
     └── main.cpp
```

---

## 4. Full Code Listing

### 4.1 `include/pf_client/exceptions.hpp`
```cpp
#pragma once
/**
 * @file exceptions.hpp
 * @brief Strongly-typed error hierarchy for PaletteFlux clients.
 */
#include <stdexcept>
#include <string>

namespace pf::client
{
struct HttpError final : public std::runtime_error
{
    long statusCode;
    explicit HttpError(long code, const std::string& msg)
        : std::runtime_error(msg), statusCode(code) {}
};

struct GraphQLError final : public std::runtime_error
{
    explicit GraphQLError(const std::string& msg)
        : std::runtime_error(msg) {}
};

struct TimeoutError final : public std::runtime_error
{
    explicit TimeoutError(const std::string& msg)
        : std::runtime_error(msg) {}
};
} // namespace pf::client
```

---

### 4.2 `include/pf_client/GraphQLClient.hpp`
```cpp
#pragma once
/**
 * @file GraphQLClient.hpp
 * @brief Lightweight, RAII-style GraphQL client for PaletteFlux.
 */

#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <memory>
#include <string>
#include <unordered_map>
#include "exceptions.hpp"

namespace pf::client
{
class GraphQLClient
{
public:
    explicit GraphQLClient(std::string endpoint, long timeoutMs = 5000);
    ~GraphQLClient();

    // Non-copyable, but movable
    GraphQLClient(const GraphQLClient&)            = delete;
    GraphQLClient& operator=(const GraphQLClient&) = delete;
    GraphQLClient(GraphQLClient&&) noexcept;
    GraphQLClient& operator=(GraphQLClient&&) noexcept;

    [[nodiscard]] nlohmann::json query(
        const std::string&              document,
        const nlohmann::json&           variables = {},
        const std::unordered_map<std::string, std::string>& headers = {}) const;

    void setAuthToken(std::string token);
    void setTimeout(long timeoutMs);

private:
    static size_t writeCallback(char* ptr, size_t size, size_t nmemb, void* userdata);

    std::string m_endpoint;
    std::string m_authToken;
    long        m_timeout;
    mutable CURL* m_curl;
    mutable struct curl_slist* m_defaultHeaders;

    void initCurl();
    void cleanupCurl() const;
};
} // namespace pf::client
```

---

### 4.3 `include/pf_client/RestClient.hpp`
```cpp
#pragma once
/**
 * @file RestClient.hpp
 * @brief Fetches read-only, cache-friendly snapshots from PaletteFlux REST endpoints.
 */

#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <memory>
#include <string>
#include "exceptions.hpp"

namespace pf::client
{
class RestClient
{
public:
    explicit RestClient(std::string baseUrl, long timeoutMs = 5000);
    ~RestClient();

    RestClient(const RestClient&)            = delete;
    RestClient& operator=(const RestClient&) = delete;
    RestClient(RestClient&&) noexcept;
    RestClient& operator=(RestClient&&) noexcept;

    [[nodiscard]] nlohmann::json get(const std::string& path) const;

    void setTimeout(long timeoutMs);

private:
    static size_t writeCallback(char* ptr, size_t size, size_t nmemb, void* userdata);

    std::string m_baseUrl;
    long        m_timeout;
    mutable CURL* m_curl;

    void initCurl();
    void cleanupCurl() const;
};
} // namespace pf::client
```

---

### 4.4 `src/GraphQLClient.cpp`
```cpp
#include "pf_client/GraphQLClient.hpp"
#include <fmt/core.h>
#include <sstream>

using namespace pf::client;

GraphQLClient::GraphQLClient(std::string endpoint, long timeoutMs)
    : m_endpoint(std::move(endpoint))
    , m_timeout(timeoutMs)
    , m_curl(nullptr)
    , m_defaultHeaders(nullptr)
{
    initCurl();
}

GraphQLClient::~GraphQLClient()
{
    cleanupCurl();
}

GraphQLClient::GraphQLClient(GraphQLClient&& other) noexcept
    : m_endpoint(std::move(other.m_endpoint))
    , m_authToken(std::move(other.m_authToken))
    , m_timeout(other.m_timeout)
    , m_curl(other.m_curl)
    , m_defaultHeaders(other.m_defaultHeaders)
{
    other.m_curl            = nullptr;
    other.m_defaultHeaders  = nullptr;
}

GraphQLClient& GraphQLClient::operator=(GraphQLClient&& other) noexcept
{
    if (this != &other)
    {
        cleanupCurl();
        m_endpoint          = std::move(other.m_endpoint);
        m_authToken         = std::move(other.m_authToken);
        m_timeout           = other.m_timeout;
        m_curl              = other.m_curl;
        m_defaultHeaders    = other.m_defaultHeaders;
        other.m_curl        = nullptr;
        other.m_defaultHeaders = nullptr;
    }
    return *this;
}

void GraphQLClient::initCurl()
{
    m_curl = curl_easy_init();
    if (!m_curl) throw std::runtime_error("Failed to init curl");

    // Default headers – application/json
    m_defaultHeaders = curl_slist_append(nullptr, "Content-Type: application/json");
}

void GraphQLClient::cleanupCurl() const
{
    if (m_curl) curl_easy_cleanup(m_curl);
    if (m_defaultHeaders) curl_slist_free_all(m_defaultHeaders);
}

void GraphQLClient::setAuthToken(std::string token)
{
    m_authToken = std::move(token);
}

void GraphQLClient::setTimeout(long timeoutMs)
{
    m_timeout = timeoutMs;
}

size_t GraphQLClient::writeCallback(char* ptr, size_t size, size_t nmemb, void* userdata)
{
    auto* stream = static_cast<std::string*>(userdata);
    stream->append(ptr, size * nmemb);
    return size * nmemb;
}

nlohmann::json GraphQLClient::query(const std::string&                              document,
                                    const nlohmann::json&                           variables,
                                    const std::unordered_map<std::string, std::string>& headers) const
{
    if (!m_curl) throw std::runtime_error("Curl not initialised");

    nlohmann::json payload = {
        {"query",     document},
        {"variables", variables}
    };
    std::string payloadStr = payload.dump();

    std::string responseBuffer;
    curl_easy_reset(m_curl);
    curl_easy_setopt(m_curl, CURLOPT_URL, m_endpoint.c_str());
    curl_easy_setopt(m_curl, CURLOPT_POST, 1L);
    curl_easy_setopt(m_curl, CURLOPT_POSTFIELDS, payloadStr.c_str());
    curl_easy_setopt(m_curl, CURLOPT_POSTFIELDSIZE, payloadStr.size());
    curl_easy_setopt(m_curl, CURLOPT_TIMEOUT_MS, m_timeout);
    curl_easy_setopt(m_curl, CURLOPT_WRITEFUNCTION, writeCallback);
    curl_easy_setopt(m_curl, CURLOPT_WRITEDATA, &responseBuffer);

    // Build header list
    struct curl_slist* headerList = nullptr;
    headerList                    = curl_slist_append(headerList, "Accept: application/json");
    for (const auto& [k, v] : headers)
    {
        headerList = curl_slist_append(headerList, fmt::format("{}: {}", k, v).c_str());
    }
    if (!m_authToken.empty())
    {
        headerList = curl_slist_append(headerList, fmt::format("Authorization: Bearer {}", m_authToken).c_str());
    }
    // Concatenate default headers last to guarantee Content-Type
    struct curl_slist* merged = curl_slist_append(headerList, "Content-Type: application/json");
    curl_easy_setopt(m_curl, CURLOPT_HTTPHEADER, merged);

    CURLcode res = curl_easy_perform(m_curl);
    long     httpCode{0};
    curl_easy_getinfo(m_curl, CURLINFO_RESPONSE_CODE, &httpCode);

    curl_slist_free_all(merged); // headerList inside is also freed.

    if (res == CURLE_OPERATION_TIMEDOUT)
        throw TimeoutError(fmt::format("GraphQL request timed out after {} ms", m_timeout));
    if (res != CURLE_OK)
        throw HttpError(httpCode, fmt::format("Network error: {}", curl_easy_strerror(res)));
    if (httpCode >= 400)
        throw HttpError(httpCode, fmt::format("HTTP error: {}", httpCode));

    // Parse JSON
    auto json = nlohmann::json::parse(responseBuffer, nullptr, /*allow_exceptions=*/true);

    if (json.contains("errors"))
        throw GraphQLError(json["errors"].dump());

    return json["data"];
}
```

---

### 4.5 `src/RestClient.cpp`
```cpp
#include "pf_client/RestClient.hpp"
#include <fmt/core.h>

using namespace pf::client;

RestClient::RestClient(std::string baseUrl, long timeoutMs)
    : m_baseUrl(std::move(baseUrl))
    , m_timeout(timeoutMs)
    , m_curl(nullptr)
{
    initCurl();
}

RestClient::~RestClient()
{
    cleanupCurl();
}

RestClient::RestClient(RestClient&& other) noexcept
    : m_baseUrl(std::move(other.m_baseUrl))
    , m_timeout(other.m_timeout)
    , m_curl(other.m_curl)
{
    other.m_curl = nullptr;
}

RestClient& RestClient::operator=(RestClient&& other) noexcept
{
    if (this != &other)
    {
        cleanupCurl();
        m_baseUrl = std::move(other.m_baseUrl);
        m_timeout = other.m_timeout;
        m_curl    = other.m_curl;
        other.m_curl = nullptr;
    }
    return *this;
}

void RestClient::initCurl()
{
    m_curl = curl_easy_init();
    if (!m_curl) throw std::runtime_error("Failed to init curl");
}

void RestClient::cleanupCurl() const
{
    if (m_curl) curl_easy_cleanup(m_curl);
}

void RestClient::setTimeout(long timeoutMs)
{
    m_timeout = timeoutMs;
}

size_t RestClient::writeCallback(char* ptr, size_t size, size_t nmemb, void* userdata)
{
    auto* stream = static_cast<std::string*>(userdata);
    stream->append(ptr, size * nmemb);
    return size * nmemb;
}

nlohmann::json RestClient::get(const std::string& path) const
{
    if (!m_curl) throw std::runtime_error("Curl not initialised");

    std::string responseBuffer;
    curl_easy_reset(m_curl);

    const std::string url = m_baseUrl + path;
    curl_easy_setopt(m_curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(m_curl, CURLOPT_HTTPGET, 1L);
    curl_easy_setopt(m_curl, CURLOPT_TIMEOUT_MS, m_timeout);
    curl_easy_setopt(m_curl, CURLOPT_WRITEFUNCTION, writeCallback);
    curl_easy_setopt(m_curl, CURLOPT_WRITEDATA, &responseBuffer);

    CURLcode res = curl_easy_perform(m_curl);
    long     httpCode{0};
    curl_easy_getinfo(m_curl, CURLINFO_RESPONSE_CODE, &httpCode);

    if (res == CURLE_OPERATION_TIMEDOUT)
        throw TimeoutError(fmt::format("REST request timed out after {} ms", m_timeout));
    if (res != CURLE_OK)
        throw HttpError(httpCode, fmt::format("Network error: {}", curl_easy_strerror(res)));
    if (httpCode >= 400)
        throw HttpError(httpCode, fmt::format("HTTP error: {}", httpCode));

    return nlohmann::json::parse(responseBuffer, nullptr, /*allow_exceptions=*/true);
}
```

---

### 4.6 `src/main.cpp`
```cpp
#include "pf_client/GraphQLClient.hpp"
#include "pf_client/RestClient.hpp"
#include <fmt/core.h>
#include <iostream>

using namespace pf::client;

static const char* kSampleQuery = R"gql(
query SampleBrushes($limit: Int!) {
  brushes(first: $limit) {
    edges {
      node {
        id
        name
        shader {
          id
          glsl
        }
      }
    }
  }
}
)gql";

int main(int argc, char* argv[])
{
    try
    {
        GraphQLClient gql("https://studio.paletteflux.com/graphql");
        gql.setAuthToken("your-jwt-token");

        nlohmann::json variables = {{"limit", 3}};
        auto data = gql.query(kSampleQuery, variables);

        fmt::print("GraphQL response:\n{}\n", data.dump(2));

        // Fetch a REST snapshot for CDN-friendly distribution
        RestClient rest("https://cdn.paletteflux.com/api/v1/");
        auto snapshot = rest.get("brushes/snapshot.json");
        fmt::print("REST snapshot:\n{}\n", snapshot.dump(2));
    }
    catch (const HttpError& e)
    {
        fmt::print(stderr, "HTTP error ({}): {}\n", e.statusCode, e.what());
        return EXIT_FAILURE;
    }
    catch (const GraphQLError& e)
    {
        fmt::print(stderr, "GraphQL error: {}\n", e.what());
        return EXIT_FAILURE;
    }
    catch (const TimeoutError& e)
    {
        fmt::print(stderr, "Timeout: {}\n", e.what());
        return EXIT_FAILURE;
    }
    catch (const std::exception& e)
    {
        fmt::print(stderr, "Unexpected error: {}\n", e.what());
        return EXIT_FAILURE;
    }

    return EXIT_SUCCESS;
}
```

---

### 4.7 `CMakeLists.txt`
```cmake
cmake_minimum_required(VERSION 3.20)
project(paletteflux_cli LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

include(FetchContent)

# -------------------- Dependencies --------------------
FetchContent_Declare(
    curl
    URL https://github.com/curl/curl/archive/refs/tags/curl-8_7_1.tar.gz
)
FetchContent_MakeAvailable(curl)

FetchContent_Declare(
    json
    URL https://github.com/nlohmann/json/releases/download/v3.11.2/json.tar.xz
)
FetchContent_MakeAvailable(json)

FetchContent_Declare(
    fmt
    URL https://github.com/fmtlib/fmt/archive/refs/tags/10.2.1.tar.gz
)
FetchContent_MakeAvailable(fmt)

# -------------------- Library --------------------
add_library(pf_client
    src/GraphQLClient.cpp
    src/RestClient.cpp
)
target_include_directories(pf_client PUBLIC include)
target_link_libraries(pf_client
    PRIVATE
        CURL::libcurl
        nlohmann_json::nlohmann_json
        fmt::fmt
)

# -------------------- Executable --------------------
add_executable(paletteflux_cli src/main.cpp)
target_link_libraries(paletteflux_cli PRIVATE pf_client)

# Enable LTO for production builds
include(CheckIPOSupported)
check_ipo_supported(RESULT ipo_supported OUTPUT error)
if(ipo_supported)
    set(CMAKE_INTERPROCEDURAL_OPTIMIZATION_RELEASE TRUE)
endif()
```

---

## 5. Running the Client

```bash
./paletteflux_cli
```

Expected output (abridged):

```
GraphQL response:
{
  "brushes": {
    "edges": [
      {
        "node": {
          "id": "brush_01",
          "name": "Ink Splash",
          "shader": { "id": "shader_a", "glsl": "void main() { ... }" }
        }
      }
      ...
    ]
  }
}

REST snapshot:
{
  "generatedAt": "2024-05-18T08:32:01Z",
  "brushes": [
    { "id": "brush_01", "name": "Ink Splash" },
    ...
  ]
}
```

---

## 6. Contributing

Pull requests are welcome! Make sure to:

1. Run `clang-tidy` and `clang-format`.  
2. Add unit tests (`Catch2` is included as an optional dependency).  
3. Follow the [Contributor Covenant](https://www.contributor-covenant.org/) code of conduct.

---

## 7. License

This client is distributed under the **MIT License**.  
© 2024 PaletteFlux Studios.
```