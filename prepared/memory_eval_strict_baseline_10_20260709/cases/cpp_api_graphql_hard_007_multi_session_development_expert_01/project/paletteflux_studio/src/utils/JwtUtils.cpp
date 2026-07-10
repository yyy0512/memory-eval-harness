#include "utils/JwtUtils.h"

#include <cstdlib>                  // std::getenv
#include <mutex>                    // std::call_once, std::once_flag
#include <shared_mutex>             // std::shared_mutex
#include <stdexcept>                // std::runtime_error
#include <string>                   // std::string
#include <unordered_map>            // std::unordered_map
#include <utility>                  // std::move
#include <vector>                   // std::vector

// 3rd-party
#include <jwt-cpp/jwt.h>            // https://github.com/Thalhammer/jwt-cpp
#include <nlohmann/json.hpp>        // https://github.com/nlohmann/json
#include <spdlog/spdlog.h>          // https://github.com/gabime/spdlog

namespace paletteflux::utils
{
namespace
{
// -----------------------------------------------------------------------------
// Internal helpers / state
// -----------------------------------------------------------------------------

// Reads the signing secret from env only once.
const std::string& readSecretFromEnv()
{
    static std::once_flag flag{};
    static std::string     secret;

    std::call_once(flag, [] {
        if (const char* raw = std::getenv("PALETTEFLUX_JWT_SECRET"); raw != nullptr)
        {
            secret = raw;
        }
        else
        {
            spdlog::warn(
                "Environment variable PALETTEFLUX_JWT_SECRET is not set; falling "
                "back to insecure development default.");
            secret = "paletteflux-development-secret";
        }
    });

    return secret;
}

// Convert jwt-cpp claim to nlohmann::json value.
nlohmann::json claimToJson(const jwt::claim& claim)
{
    using json = nlohmann::json;

    switch (claim.get_type())
    {
        case jwt::claim::type::boolean:
            return json{ claim.as_bool() };
        case jwt::claim::type::string:
            return json{ claim.as_string() };
        case jwt::claim::type::array:
            return json{ claim.as_array() };
        case jwt::claim::type::integer:
            return json{ claim.as_int() };
        case jwt::claim::type::number:
            return json{ claim.as_number() };
        case jwt::claim::type::object:
            return json{ claim.as_object() };
        case jwt::claim::type::null:
        default:
            return nullptr;
    }
}

// The issuer used throughout the platform.
constexpr std::string_view kDefaultIssuer = "https://auth.paletteflux.io";
} // namespace

// -----------------------------------------------------------------------------
// JwtUtils implementation
// -----------------------------------------------------------------------------
JwtUtils::JwtUtils(std::string issuer, std::string audience)
    : m_issuer(std::move(issuer)),
      m_audience(std::move(audience)),
      m_verifier(jwt::verify()
                     .allow_algorithm(jwt::algorithm::hs256{ readSecretFromEnv() })
                     .with_issuer(m_issuer)
                     .with_audience(m_audience))
{
    if (m_issuer.empty())
        m_issuer = std::string(kDefaultIssuer);
}

std::string JwtUtils::sign(const nlohmann::json& customPayload,
                           std::chrono::seconds       expiresIn) const
{
    const auto now = std::chrono::system_clock::now();

    jwt::builder builder = jwt::create()
                               .set_issued_at(now)
                               .set_expires_at(now + expiresIn)
                               .set_issuer(m_issuer);

    if (!m_audience.empty())
        builder.set_audience(m_audience);

    // Attach user-provided custom payload
    for (auto it = customPayload.begin(); it != customPayload.end(); ++it)
    {
        // NB: All values are forwarded as JSON; jwt-cpp will encode them
        builder.set_payload_claim(it.key(), jwt::claim(it.value()));
    }

    const auto token =
        builder.sign(jwt::algorithm::hs256{ readSecretFromEnv() });

    return token;
}

nlohmann::json JwtUtils::verifyAndDecode(const std::string& token) const
{
    try
    {
        const auto decoded = jwt::decode(token);
        m_verifier.verify(decoded);

        nlohmann::json result;
        for (const auto& [key, claim] : decoded.get_payload_claims())
        {
            result[key] = claimToJson(claim);
        }

        return result;
    }
    catch (const std::exception& ex)
    {
        spdlog::warn("JWT verification failed: {}", ex.what());
        throw JwtException("Invalid or expired JWT (" + std::string(ex.what()) + ")");
    }
}

bool JwtUtils::isExpired(const std::string& token) const noexcept
{
    try
    {
        const auto decoded = jwt::decode(token);
        const auto exp     = decoded.get_expires_at();

        const auto now =
            std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());

        return now >= exp;
    }
    catch (...)
    {
        // Any decoding error is treated as expired / invalid
        return true;
    }
}

// -----------------------------------------------------------------------------
// JwtUtils (static helpers)
// -----------------------------------------------------------------------------
std::string JwtUtils::generateDevToken(const std::string& subject,
                                       std::chrono::hours  lifeTime)
{
    JwtUtils utils{ std::string(kDefaultIssuer), "paletteflux-studio" };

    nlohmann::json payload{
        { "sub", subject },
        { "scope",
          nlohmann::json::array({ "studio:read", "studio:write", "assets:*" }) }
    };
    return utils.sign(payload, std::chrono::duration_cast<std::chrono::seconds>(lifeTime));
}

// -----------------------------------------------------------------------------
// JwtException
// -----------------------------------------------------------------------------
JwtException::JwtException(std::string msg)
    : std::runtime_error(std::move(msg))
{
}

} // namespace paletteflux::utils