// chrono_flow_nexus/tests/integration/test_api_endpoints.cpp
//
// Integration‐level tests that exercise the running ChronoFlow Nexus
// micro-service over its public HTTP interface (REST & GraphQL).
//
// The tests expect a service instance to be reachable at
//   http://localhost:8080
// with an empty/ephemeral backing store.  CI pipelines start the service in a
// dedicated Docker compose network before executing this suite.
//
// GoogleTest is used as the test framework, CPR (https://github.com/libcpr/cpr)
// provides a thin cURL wrapper for issuing requests, and
// nlohmann::json (https://github.com/nlohmann/json) handles JSON parsing.
//
// Build requirements (CMake):
//   find_package(GTest REQUIRED)
//   find_package(cpr REQUIRED)
//   find_package(nlohmann_json REQUIRED)
//   target_link_libraries(test_api_endpoints PRIVATE GTest::gtest_main cpr::cpr nlohmann_json::nlohmann_json)
//
// NOTE:  To run only integration tests locally, set:
//          CTEST_OUTPUT_ON_FAILURE=1
// and optionally:
//          CFN_BASE_URL=http://my-custom-url:port
// -----------------------------------------------------------------------------

#include <gtest/gtest.h>

#include <cpr/cpr.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdlib>
#include <random>
#include <regex>
#include <string>
#include <thread>
#include <unordered_map>

using json = nlohmann::json;

// -------------------------------------------------------
// Utility helpers
// -------------------------------------------------------

namespace {

constexpr std::chrono::seconds kServiceStartupTimeout{30};
constexpr std::chrono::milliseconds kPollInterval{750};

// Resolve the base URL from the environment or fallback to localhost.
std::string baseUrl()
{
    const char* env = std::getenv("CFN_BASE_URL");
    return env ? std::string{env} : "http://localhost:8080";
}

// Blocks until the ping endpoint reports readiness.
void waitForServiceReadiness()
{
    const auto deadline = std::chrono::steady_clock::now() + kServiceStartupTimeout;

    while (std::chrono::steady_clock::now() < deadline)
    {
        cpr::Response res = cpr::Get(cpr::Url{baseUrl() + "/api/v1/ping"},
                                     cpr::Timeout{1500});

        if (res.status_code == 200)
        {
            try
            {
                auto payload = json::parse(res.text);
                if (payload.value("status", "") == "ok") { return; }
            }
            catch (...) {/* swallow JSON parse errors while waiting */}
        }

        std::this_thread::sleep_for(kPollInterval);
    }

    FAIL() << "ChronoFlow Nexus did not become ready within "
           << kServiceStartupTimeout.count() << " seconds";
}

// Produces a deterministic pseudo-random integer ID for repeatability in CI.
int64_t deterministicRandomId()
{
    // Seeded with a fixed value so ids are stable across executions.
    static std::mt19937_64 rng{0xBADC0FFEE0DDF00D};
    std::uniform_int_distribution<int64_t> dist(10'000, 99'999);
    return dist(rng);
}

// Convenience for creating the common headers we use across requests.
cpr::Header defaultHeaders()
{
    return {
        {"Content-Type", "application/json"},
        {"Accept", "application/json"}
    };
}

// GraphQL helper that wraps the request body formatting.
cpr::Response graphqlRequest(std::string_view query, const json& variables = {})
{
    json body {
        {"query", query},
        {"variables", variables}
    };

    return cpr::Post(
        cpr::Url{baseUrl() + "/graphql"},
        defaultHeaders(),
        cpr::Body{body.dump()},
        cpr::Timeout{3000}
    );
}

} // namespace (anonymous)

// -------------------------------------------------------
// Test fixture
// -------------------------------------------------------

class ChronoFlowIntegration : public ::testing::Test
{
protected:
    void SetUp() override
    {
        static std::once_flag once;
        std::call_once(once, [] { waitForServiceReadiness(); });
        // Ensure every test starts from a clean slate.
        resetServiceState();
    }

    // Dispatches an integrator-only endpoint that clears DB/cache.
    static void resetServiceState()
    {
        cpr::Response res = cpr::Post(
            cpr::Url{baseUrl() + "/admin/reset"},
            cpr::Timeout{3000}
        );

        ASSERT_EQ(res.status_code, 204) << "Failed to reset service state";
    }
};

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

TEST_F(ChronoFlowIntegration, PingEndpoint_HappyPath)
{
    cpr::Response res = cpr::Get(
        cpr::Url{baseUrl() + "/api/v1/ping"},
        defaultHeaders(),
        cpr::Timeout{1000}
    );

    ASSERT_EQ(res.status_code, 200);
    ASSERT_EQ(res.header["Content-Type"], "application/json");

    auto obj = json::parse(res.text);
    EXPECT_EQ(obj.value("status", ""), "ok");
}

TEST_F(ChronoFlowIntegration, CreateTimeEntry_AndRetrieve)
{
    // Compose a legitimate creation payload.
    const int64_t idSeed = deterministicRandomId();
    json payload = {
        {"user_id",        42},
        {"task_id",        1337},
        {"seconds_spent",  1800},
        {"note",           "Integration test entry #" + std::to_string(idSeed)}
    };

    // POST /time-entries
    cpr::Response createRes = cpr::Post(
        cpr::Url{baseUrl() + "/api/v1/time-entries"},
        defaultHeaders(),
        cpr::Body{payload.dump()},
        cpr::Timeout{2500}
    );

    ASSERT_EQ(createRes.status_code, 201);
    ASSERT_TRUE(createRes.header.contains("Location"));
    ASSERT_TRUE(createRes.header.contains("ETag"));

    // Extract entity ID from Location header (e.g., /api/v1/time-entries/12345)
    static const std::regex idRegex{R"(\/time-entries\/(\d+)$)"};
    std::smatch match;
    ASSERT_TRUE(std::regex_search(createRes.header["Location"], match, idRegex));
    const std::string entryId = match[1];

    // GET /time-entries/{id}
    cpr::Response getRes = cpr::Get(
        cpr::Url{baseUrl() + "/api/v1/time-entries/" + entryId},
        defaultHeaders(),
        cpr::Timeout{1500}
    );

    ASSERT_EQ(getRes.status_code, 200);
    ASSERT_EQ(getRes.header["ETag"], createRes.header["ETag"]);

    json jsonRes = json::parse(getRes.text);

    EXPECT_EQ(jsonRes["id"], std::stoll(entryId));
    EXPECT_EQ(jsonRes["user_id"], payload["user_id"]);
    EXPECT_EQ(jsonRes["task_id"], payload["task_id"]);
    EXPECT_EQ(jsonRes["seconds_spent"], payload["seconds_spent"]);
    EXPECT_EQ(jsonRes["note"], payload["note"]);
}

TEST_F(ChronoFlowIntegration, FlowStateAnalytics_PaginationAndCaching)
{
    // Populate minimal dummy data set
    constexpr int kNumEntries = 15;
    for (int i = 0; i < kNumEntries; ++i)
    {
        json payload = {
            {"user_id",        999},
            {"task_id",        5000 + i},
            {"seconds_spent",  1200},
            {"note",           "dummy"}
        };
        cpr::Post(cpr::Url{baseUrl() + "/api/v1/time-entries"},
                  defaultHeaders(),
                  cpr::Body{payload.dump()},
                  cpr::Timeout{2500});
    }

    // Query paginated analytics (page 1)
    cpr::Response page1 = cpr::Get(
        cpr::Url{baseUrl() + "/api/v1/analytics/flow-state?user_id=999&page=1&per_page=10"},
        defaultHeaders(),
        cpr::Timeout{2000}
    );

    ASSERT_EQ(page1.status_code, 200);
    ASSERT_EQ(page1.header["Content-Type"], "application/json");
    ASSERT_TRUE(page1.header.contains("X-Total-Pages"));
    ASSERT_TRUE(page1.header.contains("X-RateLimit-Remaining"));

    int totalPages = std::stoi(page1.header["X-Total-Pages"]);
    EXPECT_EQ(totalPages, 2); // 15 entries @ per_page=10 => 2 pages

    json jPage1 = json::parse(page1.text);
    EXPECT_EQ(jPage1["entries"].size(), 10);

    // Validate presence of caching headers
    EXPECT_TRUE(page1.header.contains("ETag"));
    const std::string etag1 = page1.header["ETag"];

    // Re-issue the identical request and expect 304 Not Modified
    cpr::Response cachedRes = cpr::Get(
        cpr::Url{baseUrl() + "/api/v1/analytics/flow-state?user_id=999&page=1&per_page=10"},
        cpr::Header{
            {"If-None-Match", etag1},
            {"Accept", "application/json"}
        },
        cpr::Timeout{2000}
    );

    EXPECT_EQ(cachedRes.status_code, 304);
}

TEST_F(ChronoFlowIntegration, GraphQL_TimeOnTaskQuery)
{
    constexpr const char* kQuery = R"GRAPHQL(
        query TimeOnTask($uid: ID!, $limit: Int!) {
            timeOnTask(userId: $uid, limit: $limit) {
                taskId
                secondsSpent
                lastUpdated
            }
        }
    )GRAPHQL";

    json variables = {
        {"uid", 42},
        {"limit", 3}
    };

    // Seed some data so the query will return results.
    for (int i = 0; i < 3; ++i)
    {
        json payload = {
            {"user_id",        42},
            {"task_id",        1234 + i},
            {"seconds_spent",  600 * (i + 1)},
            {"note",           "GraphQL seed"}
        };

        cpr::Post(
            cpr::Url{baseUrl() + "/api/v1/time-entries"},
            defaultHeaders(),
            cpr::Body{payload.dump()},
            cpr::Timeout{3000}
        );
    }

    cpr::Response res = graphqlRequest(kQuery, variables);

    ASSERT_EQ(res.status_code, 200);
    ASSERT_EQ(res.header["Content-Type"], "application/json");

    json response = json::parse(res.text);

    // Assert no GraphQL errors
    ASSERT_FALSE(response.contains("errors")) << response.dump(2);

    auto items = response["data"]["timeOnTask"];
    ASSERT_TRUE(items.is_array());
    EXPECT_EQ(items.size(), 3);

    for (const auto& item : items)
    {
        EXPECT_TRUE(item["taskId"].is_number_integer());
        EXPECT_TRUE(item["secondsSpent"].is_number_integer());
        EXPECT_TRUE(item["lastUpdated"].is_string());
    }
}

TEST_F(ChronoFlowIntegration, CreateTimeEntry_InvalidPayload_ShouldFailGracefully)
{
    // Intentionally omit required field task_id
    json invalidPayload = {
        {"user_id",       123},
        {"seconds_spent", 500},
        {"note",          "incomplete"}
    };

    cpr::Response res = cpr::Post(
        cpr::Url{baseUrl() + "/api/v1/time-entries"},
        defaultHeaders(),
        cpr::Body{invalidPayload.dump()},
        cpr::Timeout{2500}
    );

    EXPECT_EQ(res.status_code, 400);

    json errorBody = json::parse(res.text);
    EXPECT_EQ(errorBody.value("error_code", ""), "VALIDATION_ERROR");
    EXPECT_TRUE(errorBody.contains("message"));
}

// -------------------------------------------------------
// Main entry point
// -------------------------------------------------------

int main(int argc, char** argv)
{
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}