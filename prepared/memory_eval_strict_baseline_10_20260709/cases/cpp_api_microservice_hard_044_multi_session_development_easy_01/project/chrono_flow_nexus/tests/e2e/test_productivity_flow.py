```cpp
// chrono_flow_nexus/tests/e2e/test_productivity_flow.cpp
//
// End-to-end tests that exercise ChronoFlow Nexus’ public HTTP surface.
// The test-runner is GoogleTest; networking is handled through libcurl,
// and JSON parsing/serialization via nlohmann::json (single-header).
//
// To build (example CMake snippet):
//   find_package(CURL REQUIRED)
//   find_package(GTest REQUIRED)
//   add_executable(test_productivity_flow test_productivity_flow.cpp)
//   target_link_libraries(test_productivity_flow PRIVATE GTest::gtest CURL::libcurl)
//   target_include_directories(test_productivity_flow PRIVATE ${PROJECT_SOURCE_DIR}/external) // nlohmann/json
//
// Environment variables:
//   CF_NEXUS_BASE_URL – base URL of the running ChronoFlow Nexus service
//
// ----------------------------------------------------------------------

#include <gtest/gtest.h>
#include <curl/curl.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace chrono_flow::e2e {

using json = nlohmann::json;

// RAII wrapper that guarantees curl_global_init / cleanup
class CurlGlobalInit {
public:
    CurlGlobalInit() {
        CURLcode res = curl_global_init(CURL_GLOBAL_DEFAULT);
        if (res != CURLE_OK) {
            throw std::runtime_error("curl_global_init failed");
        }
    }
    ~CurlGlobalInit() { curl_global_cleanup(); }
};

// Simple HTTP response abstraction
struct HttpResponse {
    long status = 0;
    std::string body;
    std::unordered_map<std::string, std::string> headers;

    [[nodiscard]] bool ok() const noexcept { return status >= 200 && status < 300; }

    std::string header(const std::string& key) const {
        auto it = headers.find(key);
        return it == headers.end() ? "" : it->second;
    }
};

// Minimal, blocking HTTP client that performs JSON-aware requests
class HttpClient {
public:
    explicit HttpClient(std::string baseUrl) : baseUrl_(std::move(baseUrl)) {
        if (baseUrl_.empty()) { throw std::invalid_argument("base URL must not be empty"); }
        if (baseUrl_.back() == '/') { baseUrl_.pop_back(); }
    }

    HttpResponse get(const std::string& path,
                     const std::unordered_map<std::string, std::string>& query = {},
                     const std::unordered_map<std::string, std::string>& headers = {}) const {
        std::string url = buildUrl(path, query);
        return performRequest("GET", url, {}, headers);
    }

    HttpResponse post(const std::string& path,
                      const json& payload,
                      const std::unordered_map<std::string, std::string>& headers = {}) const {
        std::string url = buildUrl(path, {});
        return performRequest("POST", url, payload.dump(), headers, "application/json");
    }

private:
    static size_t writeCallback(char* ptr, size_t size, size_t nmemb, void* userdata) {
        auto* stream = static_cast<std::string*>(userdata);
        size_t total = size * nmemb;
        stream->append(ptr, total);
        return total;
    }

    static size_t headerCallback(char* buffer, size_t size, size_t nitems, void* userdata) {
        auto* headers = static_cast<std::unordered_map<std::string, std::string>*>(userdata);
        size_t total = size * nitems;
        std::string headerLine(buffer, total);

        auto sep = headerLine.find(':');
        if (sep != std::string::npos) {
            std::string key = headerLine.substr(0, sep);
            std::string value = headerLine.substr(sep + 1);
            // Trim whitespace, CR, LF
            auto lTrim = [](std::string& s) {
                s.erase(s.begin(), std::find_if(s.begin(), s.end(), [](unsigned char c) { return !std::isspace(c); }));
            };
            auto rTrim = [](std::string& s) {
                s.erase(std::find_if(s.rbegin(), s.rend(), [](unsigned char c) { return !std::isspace(c); }).base(), s.end());
            };
            lTrim(key);
            rTrim(key);
            lTrim(value);
            rTrim(value);

            if (!key.empty()) { (*headers)[key] = value; }
        }
        return total;
    }

    HttpResponse performRequest(const std::string& method,
                                const std::string& url,
                                const std::string& body,
                                const std::unordered_map<std::string, std::string>& headers,
                                const std::string& contentType = {}) const {
        CURL* curl = curl_easy_init();
        if (!curl) { throw std::runtime_error("Failed to create CURL handle"); }

        std::string responseBody;
        std::unordered_map<std::string, std::string> responseHeaders;
        struct curl_slist* headerList = nullptr;

        // Compose request headers
        for (const auto& [k, v] : headers) {
            headerList = curl_slist_append(headerList, (k + ": " + v).c_str());
        }
        if (!contentType.empty()) {
            headerList = curl_slist_append(headerList, ("Content-Type: " + contentType).c_str());
        }

        curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headerList);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT, 10L);
        curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);

        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, &writeCallback);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &responseBody);

        curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, &headerCallback);
        curl_easy_setopt(curl, CURLOPT_HEADERDATA, &responseHeaders);

        if (method == "POST") {
            curl_easy_setopt(curl, CURLOPT_POST, 1L);
            curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, body.size());
            curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.data());
        }

        CURLcode res = curl_easy_perform(curl);

        HttpResponse response;
        if (res == CURLE_OK) {
            curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response.status);
            response.body = std::move(responseBody);
            response.headers = std::move(responseHeaders);
        } else {
            response.status = 0;
            response.body = curl_easy_strerror(res);
        }

        curl_slist_free_all(headerList);
        curl_easy_cleanup(curl);
        return response;
    }

    static std::string urlEncode(const std::string& value) {
        char* output = curl_easy_escape(nullptr, value.c_str(), static_cast<int>(value.length()));
        if (!output) { throw std::runtime_error("curl_easy_escape failed"); }
        std::string encoded(output);
        curl_free(output);
        return encoded;
    }

    std::string buildUrl(const std::string& path,
                         const std::unordered_map<std::string, std::string>& query) const {
        std::ostringstream oss;
        oss << baseUrl_;
        if (path.empty() || path[0] != '/') { oss << '/'; }
        oss << path;
        if (!query.empty()) {
            oss << '?';
            bool first = true;
            for (const auto& [k, v] : query) {
                if (!first) oss << '&';
                oss << urlEncode(k) << '=' << urlEncode(v);
                first = false;
            }
        }
        return oss.str();
    }

    std::string baseUrl_;
};

// ----------------------------------------------------------------------
// Helper utilities
// ----------------------------------------------------------------------

std::string getBaseUrl() {
    const char* env = std::getenv("CF_NEXUS_BASE_URL");
    if (!env) {
        throw std::runtime_error("Environment variable CF_NEXUS_BASE_URL is not set. "
                                 "Point it to a running ChronoFlow Nexus instance.");
    }
    return std::string(env);
}

// ----------------------------------------------------------------------
// Test Suite: Productivity Flow
// ----------------------------------------------------------------------

class ProductivityFlowTest : public ::testing::Test {
protected:
    static void SetUpTestSuite() {
        static CurlGlobalInit init; // one-time global initialization
        http = std::make_unique<HttpClient>(getBaseUrl());
    }

    static std::unique_ptr<HttpClient> http;
};

std::unique_ptr<HttpClient> ProductivityFlowTest::http = nullptr;

// ----------------------------------------------------------------------
// Test #1: REST time-tracking summary
// ----------------------------------------------------------------------

TEST_F(ProductivityFlowTest, TimeTrackingSummaryRestEndpoint) {
    const std::string userId = "u-e2e-tester";
    HttpResponse res = http->get("/api/v1/productivity/summary",
                                 {{"userId", userId}, {"period", "week"}});

    ASSERT_TRUE(res.ok()) << "Unexpected status: " << res.status << "\nBody: " << res.body;

    json payload = json::parse(res.body, nullptr, /*allow_exceptions=*/false);
    ASSERT_FALSE(payload.is_discarded()) << "Invalid JSON payload";

    ASSERT_TRUE(payload.contains("total_focus_minutes"));
    ASSERT_TRUE(payload.contains("tasks_completed"));

    int focusMinutes = payload["total_focus_minutes"].get<int>();
    int tasksCompleted = payload["tasks_completed"].get<int>();

    EXPECT_GE(focusMinutes, 0);
    EXPECT_GE(tasksCompleted, 0);
}

// ----------------------------------------------------------------------
// Test #2: GraphQL productivity query
// ----------------------------------------------------------------------

TEST_F(ProductivityFlowTest, GraphQLProductivityQuery) {
    const char* gqlQuery = R"(
        query ProductiveDay($user: ID!, $date: Date!) {
            productivity {
                daily(userId: $user, date: $date) {
                    focusMinutes
                    contextSwitches
                    tasks {
                        id
                        title
                        timeSpentMinutes
                    }
                }
            }
        })";

    json variables = {{"user", "u-e2e-tester"}, {"date", "today"}};
    json requestPayload = {{"query", gqlQuery}, {"variables", variables}};

    HttpResponse res = http->post("/graphql", requestPayload);

    ASSERT_TRUE(res.ok()) << "GQL request failed with status " << res.status << "\nBody: " << res.body;

    json payload = json::parse(res.body, nullptr, /*allow_exceptions=*/false);
    ASSERT_FALSE(payload.is_discarded()) << "Response is not valid JSON";

    ASSERT_FALSE(payload.contains("errors")) << payload.dump(2);

    auto daily = payload["data"]["productivity"]["daily"];
    int focusMinutes = daily["focusMinutes"].get<int>();
    int contextSwitches = daily["contextSwitches"].get<int>();

    EXPECT_GE(focusMinutes, 0);
    EXPECT_GE(contextSwitches, 0);
}

// ----------------------------------------------------------------------
// Test #3: Cached responses are actually cached
// ----------------------------------------------------------------------

TEST_F(ProductivityFlowTest, ResponseCachingHit) {
    const std::string userId = "u-e2e-tester";
    const auto query = std::unordered_map<std::string, std::string>{
        {"userId", userId},
        {"period", "day"},
    };

    // First request – prime the cache
    HttpResponse res1 = http->get("/api/v1/productivity/summary", query);
    ASSERT_TRUE(res1.ok());

    // Wait a small time to ensure second request is not slower due to network noise
    std::this_thread::sleep_for(std::chrono::milliseconds(200));

    // Second request should ideally be served from cache
    auto start = std::chrono::steady_clock::now();
    HttpResponse res2 = http->get("/api/v1/productivity/summary", query);
    auto durationMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                          std::chrono::steady_clock::now() - start)
                          .count();

    ASSERT_TRUE(res2.ok());
    EXPECT_EQ(res2.header("X-Cache"), "HIT") << "Backend did not report cached response";
    EXPECT_LT(durationMs, 100) << "Cached response took unexpectedly long";
}

// ----------------------------------------------------------------------
// Test #4: Adaptive rate-limiting – exceed quota, expect HTTP 429
// ----------------------------------------------------------------------

TEST_F(ProductivityFlowTest, RateLimitingEnforced) {
    const std::string testEndpoint = "/api/v1/productivity/summary";
    const std::unordered_map<std::string, std::string> query = {
        {"userId", "u-e2e-tester"},
        {"period", "minute"},
    };

    // We'll attempt to burst-fire a set of requests that hopefully surpass
    // the configured rate limit (assumed 10 req/min for E2E environment).
    constexpr int BURST_COUNT = 15;
    int successful = 0;
    int limited    = 0;

    for (int i = 0; i < BURST_COUNT; ++i) {
        HttpResponse res = http->get(testEndpoint, query);
        if (res.status == 429) {
            ++limited;
        } else if (res.ok()) {
            ++successful;
        } else {
            ADD_FAILURE() << "Unexpected response: " << res.status;
        }
    }

    // We expect at least one 429; otherwise rate-limiting is ineffective
    EXPECT_GT(limited, 0) << "Rate-limiting did not trigger";
    // We also expect that not *all* requests were blocked
    EXPECT_GT(successful, 0) << "All requests were blocked – too strict?";
}

}  // namespace chrono_flow::e2e
```