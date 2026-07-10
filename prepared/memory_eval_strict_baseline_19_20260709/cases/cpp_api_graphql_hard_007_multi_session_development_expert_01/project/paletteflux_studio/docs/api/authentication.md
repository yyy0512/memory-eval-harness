<!-- docs/api/authentication.md -->

# PaletteFlux Studio – API Authentication Guide
Welcome to the authentication guide for PaletteFlux GraphQL Studio.  
This document covers the security schemes exposed by the API gateway and demonstrates, with modern C++20 code samples, how to obtain, cache, refresh and apply access tokens when talking to either the GraphQL or the curated REST surface.

---

## 1  Supported Authentication Flows
| Flow | When to use | Transport | Token type |
|------|-------------|-----------|------------|
| Personal Access Token (PAT) | Interactive exploration, low-volume integrations | HTTPS | Opaque string |
| OAuth 2.1 – Client Credentials | Backend-to-backend service calls | HTTPS | JWT (RS256) |
| OAuth 2.1 – Authorization Code + PKCE | End-user desktop / native tools | HTTPS | JWT (RS256) |
| Webhook HMAC Signature | Server-to-server webhook callbacks | HTTPS | Hex-encoded SHA-256 digest |

> NOTE  
> All methods are served exclusively over TLS 1.2 or newer. Any request received over plain HTTP or downgrading ciphers is refused with **400 Bad Request**.

---

## 2  Obtaining a Personal Access Token (PAT)
1. Sign in to the PaletteFlux Studio dashboard.  
2. Navigate to **Developer Settings → API Keys**.  
3. Click **Generate Token**, give it a descriptive label, and copy the value.  
4. **Store it once** – it will not be shown again.

### Example (cURL)
```bash
curl -H 'Authorization: Bearer <YOUR_PAT>' \
     -H 'Content-Type: application/json' \
     -d '{"query":"{__typename}"}' \
     https://api.paletteflux.io/graphql/v1
```

---

## 3  Service-to-Service OAuth 2.1 Client Credentials
### 3.1  Token endpoint
```
POST https://auth.paletteflux.io/oauth2/token
```

Required form parameters  

| Name | Example value | Description |
|------|---------------|-------------|
| grant_type | `client_credentials` | Fixed |
| client_id | `studio-cli` | Issued by PaletteFlux |
| client_secret | `••••••` | Keep secret |
| scope | `studio.graphql openid offline_access` | Space-delimited |

### 3.2  Minimal C++20 implementation
The sample uses **cpr** for HTTP and **nlohmann::json** for decoding – both installable via
```bash
vcpkg install cpr[openssl] nlohmann-json
```

```cpp
// File: oauth_client_credentials.cpp
// Compile: g++ -std=c++20 oauth_client_credentials.cpp -lcpr -lssl -lcrypto -pthread

#include <cpr/cpr.h>
#include <nlohmann/json.hpp>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>

struct Token {
    std::string access_token;
    std::chrono::system_clock::time_point expires_at;

    bool expired() const noexcept {
        return std::chrono::system_clock::now() + std::chrono::seconds(30) >= expires_at;
    }
};

class TokenCache {
public:
    TokenCache(std::string clientId,
               std::string clientSecret,
               std::string tokenEndpoint)
        : client_id_(std::move(clientId)),
          client_secret_(std::move(clientSecret)),
          token_endpoint_(std::move(tokenEndpoint)) {}

    // Thread-safe accessor
    std::string bearer() {
        std::scoped_lock lock(mutex_);
        if (!token_ || token_->expired()) {
            token_ = fetch();
        }
        return "Bearer " + token_->access_token;
    }

private:
    Token fetch() {
        cpr::Response res = cpr::Post(
            cpr::Url{token_endpoint_},
            cpr::Payload{
                {"grant_type", "client_credentials"},
                {"client_id", client_id_},
                {"client_secret", client_secret_},
                {"scope", "studio.graphql"}
            },
            cpr::Header{{"Accept", "application/json"}}
        );

        if (res.error) {
            throw std::runtime_error("HTTP error: " + res.error.message);
        }
        if (res.status_code != 200) {
            throw std::runtime_error("Token endpoint returned " + std::to_string(res.status_code)
                                     + " – " + res.text);
        }

        auto body = nlohmann::json::parse(res.text);
        if (!body.contains("access_token") || !body.contains("expires_in")) {
            throw std::runtime_error("Malformed token response");
        }

        Token tok;
        tok.access_token = body["access_token"].get<std::string>();
        const int expiresIn = body["expires_in"].get<int>();
        tok.expires_at = std::chrono::system_clock::now() + std::chrono::seconds(expiresIn);
        return tok;
    }

    std::mutex mutex_;
    std::optional<Token> token_;
    std::string client_id_;
    std::string client_secret_;
    std::string token_endpoint_;
};

int main() {
    try {
        const std::string clientId     = std::getenv("PF_CLIENT_ID")     ?: "";
        const std::string clientSecret = std::getenv("PF_CLIENT_SECRET") ?: "";
        if (clientId.empty() || clientSecret.empty()) {
            throw std::runtime_error("Environment variables PF_CLIENT_ID / PF_CLIENT_SECRET required");
        }

        TokenCache cache{clientId, clientSecret, "https://auth.paletteflux.io/oauth2/token"};

        // Perform a GraphQL query
        const std::string graphqlQuery = R"({
            "query": "query { health { status } }"
        })";

        cpr::Response gRes = cpr::Post(
            cpr::Url{"https://api.paletteflux.io/graphql/v1"},
            cpr::Header{
                {"Authorization", cache.bearer()},
                {"Content-Type", "application/json"}
            },
            cpr::Body{graphqlQuery}
        );

        std::cout << gRes.status_code << '\n' << gRes.text << '\n';
    } catch (const std::exception& ex) {
        std::cerr << "Fatal: " << ex.what() << '\n';
        return EXIT_FAILURE;
    }
}
```

---

## 4  Automatic Token Renewal
When using long-running background processes (render farms, CI, etc.) you **must** renew tokens before expiry.  
The `TokenCache` class above refreshes 30 seconds early (`expired()` guard). Adapt the margin as needed.

---

## 5  End-user Tools (OAuth 2.1 Authorization Code + PKCE)
Desktop applications built on the PaletteFlux SDK can leverage our **native PKCE helper** (`pfx::auth::PkceFlow`), available via the C++ SDK feed. See the SDK’s `examples/pkce_browser_login` for a full walk-through.

---

## 6  Webhook Signature Validation
Each outbound webhook carries two headers:

```
X-PaletteFlux-Timestamp: 1701104000
X-PaletteFlux-Signature: sha256=2570c8…af
```

The signature is computed as:

```
hex( SHA256( timestamp || '.' || request_body ), secret )
```

### 6.1  Minimal verifier in C++
```cpp
#include <openssl/hmac.h>
#include <fmt/core.h>
#include <string_view>
#include <iostream>

bool verify(std::string_view body,
            std::string_view timestamp,
            std::string_view providedHex,
            std::string_view secret) {

    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int len = 0;

    const std::string message = std::string{timestamp} + '.' + std::string{body};
    HMAC(EVP_sha256(),
         secret.data(), static_cast<int>(secret.size()),
         reinterpret_cast<const unsigned char*>(message.data()), message.size(),
         digest, &len);

    std::string hex;
    hex.reserve(len * 2);
    static constexpr char h[] = "0123456789abcdef";
    for (unsigned int i = 0; i < len; ++i) {
        hex.push_back(h[digest[i] >> 4]);
        hex.push_back(h[digest[i] & 0x0F]);
    }

    return providedHex == hex;
}
```

---

## 7  Common Error Codes
| Code | HTTP | Meaning |
|------|------|---------|
| `INVALID_TOKEN` | 401 | Token missing, malformed or expired |
| `INSUFFICIENT_SCOPE` | 403 | Token present but lacks required `scope` |
| `SIGNATURE_MISMATCH` | 403 | Webhook HMAC check failed |

---

## 8  JWT Claims Reference
| Claim | Type | Notes |
|-------|------|-------|
| `iss` | `https://auth.paletteflux.io/` | Issuer |
| `sub` | UUID | Principal identifier |
| `aud` | `"studio"` | Audience – always `"studio"` |
| `exp` | Unix ts | Expiration |
| `scope` | string[] | Granted scopes |

---

## 9  Troubleshooting Tips
1. Always print the full HTTP status + body – the gateway returns detailed error payloads.  
2. Ensure system time is NTP-synced; a skew > 60 s causes `exp`/`nbf` validation failures.  
3. Use `--verbose --trace-time` flags with **cpr** to debug SSL handshake issues.

---

© 2024 PaletteFlux LLC – All rights reserved.