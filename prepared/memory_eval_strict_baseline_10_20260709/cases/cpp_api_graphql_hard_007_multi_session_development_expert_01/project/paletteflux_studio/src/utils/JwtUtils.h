#ifndef PALETTEFLUX_STUDIO_SRC_UTILS_JWTUTILS_H
#define PALETTEFLUX_STUDIO_SRC_UTILS_JWTUTILS_H

/*
 * PaletteFlux GraphQL Studio
 *  Copyright ©
 *
 *  jwt_utils.h
 *
 *  A lightweight, header-only façade around jwt-cpp that helps the PaletteFlux
 *  API authenticate requests, mint refresh/access tokens, and introspect claims.
 *
 *  The implementation purposefully keeps all logic in the header to avoid
 *  coupling the core Studio runtime to a shared object that may not be present
 *  inside lambda/container targets. Consumers only need to link against
 *  jwt-cpp ≥ 0.6 and add this header to their include path.
 */

#include <jwt-cpp/jwt.h>

#include <chrono>
#include <cstdint>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>

namespace paletteflux::utils {

/**
 * JwtException
 *
 * Thin runtime-error wrapper so callers can catch *only* JWT related failures.
 */
class JwtException final : public std::runtime_error {
public:
    explicit JwtException(std::string msg)
        : std::runtime_error{std::move(msg)} {}
};

/**
 * JwtUtils
 *
 * Stateless façade around jwt-cpp that encapsulates PaletteFlux-specific
 * conventions (issuer, audience, default TTLs, etc.).  All methods are
 * thread-safe; the underlying jwt::verifier instance is immutable after
 * construction and thus read-only concurrent usage is safe.
 */
class JwtUtils final {
public:
    /**
     * TokenConfig
     *
     * Bundle of parameters required to cryptographically sign and validate JWTs.
     */
    struct TokenConfig {
        std::string issuer      = "paletteflux.studio";
        std::string audience    = "paletteflux.clients";
        std::string secret      = "change-me";     // Symmetric HS256 key
        std::chrono::seconds access_token_ttl  = std::chrono::minutes{15};
        std::chrono::seconds refresh_token_ttl = std::chrono::days{7};
    };

    explicit JwtUtils(TokenConfig cfg)
        : cfg_{std::move(cfg)}
        , algo_{jwt::algorithm::hs256{cfg_.secret}}
        , verifier_{jwt::verify()
                        .allow_algorithm(algo_)
                        .with_issuer(cfg_.issuer)
                        .with_audience(cfg_.audience)} {}

    /**
     * signAccessToken
     *
     * Creates a short-lived access token embedding caller-supplied custom
     * claims (e.g. “role”: "admin").
     */
    [[nodiscard]]
    std::string signAccessToken(
        const std::string& subject,
        const std::unordered_map<std::string, std::string>& customClaims = {}) const
    {
        using clock = std::chrono::system_clock;
        const auto now  = clock::now();
        const auto exp  = now + cfg_.access_token_ttl;

        auto builder = jwt::create()
                           .set_type("JWT")
                           .set_algorithm("HS256")
                           .set_issuer(cfg_.issuer)
                           .set_audience(cfg_.audience)
                           .set_subject(subject)
                           .set_issued_at(now)
                           .set_not_before(now)
                           .set_expires_at(exp);

        for (const auto& [k, v] : customClaims)
            builder.set_payload_claim(k, jwt::claim(v));

        return builder.sign(algo_);
    }

    /**
     * signRefreshToken
     *
     * Refresh tokens are longer-lived and intentionally carry no extra payload
     * besides the subject and issued/expiry timestamps.
     */
    [[nodiscard]]
    std::string signRefreshToken(const std::string& subject) const
    {
        using clock = std::chrono::system_clock;
        const auto now = clock::now();
        const auto exp = now + cfg_.refresh_token_ttl;

        return jwt::create()
            .set_type("JWT")
            .set_algorithm("HS256")
            .set_issuer(cfg_.issuer)
            .set_audience(cfg_.audience)
            .set_subject(subject)
            .set_issued_at(now)
            .set_not_before(now)
            .set_expires_at(exp)
            .sign(algo_);
    }

    /**
     * decode
     *
     * Returns a decoded_jwt instance.  If `verify` is true, signature and
     * registered claims are verified before return.
     */
    [[nodiscard]]
    jwt::decoded_jwt<jwt::picojson_traits>
    decode(const std::string& token, bool verify = true) const
    {
        try {
            auto decoded = jwt::decode(token);
            if (verify) {
                verifier_.verify(decoded);
            }
            return decoded;
        } catch (const std::exception& ex) {
            throw JwtException{std::string{"JWT decode failed: "} + ex.what()};
        }
    }

    /**
     * isExpired
     *
     * Convenience method to check the exp claim without throwing.
     */
    [[nodiscard]]
    bool isExpired(const std::string& token) const noexcept
    {
        try {
            const auto decoded = decode(token, /*verify=*/false);
            const auto exp     = decoded.get_expires_at();
            return std::chrono::system_clock::now() >= exp;
        } catch (...) {
            // If we cannot parse the token, treat it as expired.
            return true;
        }
    }

    /**
     * extractSubject
     *
     * Returns the `sub` claim (throws JwtException if missing/invalid).
     */
    [[nodiscard]]
    std::string extractSubject(const std::string& token) const
    {
        try {
            auto decoded = decode(token, /*verify=*/false);
            return decoded.get_subject();
        } catch (const std::exception& ex) {
            throw JwtException{std::string{"Cannot extract subject: "} + ex.what()};
        }
    }

    /**
     * hasRole
     *
     * Checks whether the token’s “role” claim equals (or contains) the provided
     * role string. If the claim is an array, performs an element lookup; if it
     * is a string, compares directly.
     */
    [[nodiscard]]
    bool hasRole(const std::string& token, const std::string& role) const
    {
        const auto decoded = decode(token, /*verify=*/false);
        if (!decoded.has_payload_claim("role")) return false;

        const auto claim = decoded.get_payload_claim("role");
        if (claim.get_type() == jwt::json::type::string) {
            return claim.as_string() == role;
        }
        if (claim.get_type() == jwt::json::type::array) {
            for (const auto& r : claim.as_array()) {
                if (r.as_string() == role) return true;
            }
        }
        return false;
    }

private:
    TokenConfig cfg_;
    jwt::algorithm::hs256 algo_;
    jwt::verifier<jwt::default_clock, jwt::picojson_traits> verifier_;
};

} // namespace paletteflux::utils

#endif // PALETTEFLUX_STUDIO_SRC_UTILS_JWTUTILS_H