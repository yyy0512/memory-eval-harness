```cpp
/*
 * PaletteFlux GraphQL Studio
 * File: paletteflux_studio/src/app/AppConfig.cpp
 *
 * Copyright (c) PaletteFlux
 *
 * Implementation of application-wide configuration loader / accessor.
 * Loads a declarative JSON configuration file, applies environment
 * variable overrides, validates the domain model, and exposes a
 * type-safe, thread-safe read-only view to the rest of the application.
 */

#include "AppConfig.hpp"

#include <cstdlib>                // std::getenv
#include <fstream>                // std::ifstream
#include <iomanip>                // std::setw
#include <mutex>                  // std::call_once, std::once_flag
#include <regex>
#include <sstream>
#include <stdexcept>
#include <utility>

#include <nlohmann/json.hpp>      // JSON for Modern C++
#include <spdlog/spdlog.h>        // Logging

namespace paletteflux::app
{

using json = nlohmann::json;

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                          */
/* -------------------------------------------------------------------------- */

namespace
{
    /*
     * Environment variable interpolation.
     *
     * Takes an input string and replaces "${VAR}" or "$VAR" patterns with the
     * corresponding value from the environment.  Unknown variables keep their
     * unresolved token so that validation can flag them later.
     */
    std::string expandEnvVars(std::string_view input)
    {
        static const std::regex envPattern(R"(\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?)");

        std::string expanded;
        expanded.reserve(input.size());

        std::cregex_iterator it(input.begin(), input.end(), envPattern);
        std::cregex_iterator end;

        std::size_t lastPos = 0;
        while (it != end)
        {
            // copy text before the match
            expanded.append(input.substr(lastPos, it->position() - lastPos));
            lastPos = it->position() + it->length();

            const char* env = std::getenv((*it)[1].str().c_str());
            if (env)
            {
                expanded.append(env);
            }
            // else leave empty string (omit token)
            ++it;
        }
        expanded.append(input.substr(lastPos));
        return expanded;
    }

    /*
     * Merge two JSON objects (shallow). The second argument overrides the first.
     * Only top-level keys are considered – suitable for configuration scoping.
     */
    json merge(const json& base, const json& overrides)
    {
        if (!base.is_object() || !overrides.is_object()) { return base; }
        json merged = base;
        for (auto& [k, v] : overrides.items())
        {
            merged[k] = v;
        }
        return merged;
    }

} // anonymous namespace

/* -------------------------------------------------------------------------- */
/*  JSON <-> Config DTO mapping                                               */
/* -------------------------------------------------------------------------- */

void from_json(const json& j, AppConfig::ServerCfg& cfg)
{
    j.at("host").get_to(cfg.host);
    j.at("port").get_to(cfg.port);
}

void from_json(const json& j, AppConfig::MonitoringCfg& cfg)
{
    j.at("enabled").get_to(cfg.enabled);
    j.value("endpoint", std::string{"/metrics"}).swap(cfg.endpoint);
}

void from_json(const json& j, AppConfig::CacheCfg& cfg)
{
    j.at("enabled").get_to(cfg.enabled);

    if (auto ttlStr = j.value("ttl", std::string{}); !ttlStr.empty())
    {
        cfg.ttl = std::chrono::seconds{std::stoul(ttlStr)};
    }
    else
    {
        cfg.ttl = std::chrono::seconds{60};
    }

    cfg.maxEntries = j.value("max_entries", 10'000UL);
}

void from_json(const json& j, AppConfig::Cfg& cfg)
{
    j.at("server").get_to(cfg.server);
    j.at("monitoring").get_to(cfg.monitoring);
    j.at("cache").get_to(cfg.cache);
    cfg.schemaPath = j.value("schema_path", std::string{"./schema.graphql"});
    cfg.logLevel   = j.value("log_level",   std::string{"info"});
    cfg.version    = j.value("api_version", std::string{"v1"});
}

/* -------------------------------------------------------------------------- */
/*  Implementation                                                            */
/* -------------------------------------------------------------------------- */

AppConfig& AppConfig::instance()
{
    // Meyers-style singleton with thread-safe initialization
    static AppConfig INSTANCE;
    return INSTANCE;
}

AppConfig::AppConfig()
{
    // hold default config until user calls load()
    m_config = buildDefaultConfig();
}

/*
 * Load configuration from disk, then apply environment overrides.
 * The procedure is idempotent and can be called multiple times to force
 * a reload (e.g. by a hot-reload endpoint exposed via GraphQL mutation).
 */
void AppConfig::load(const std::filesystem::path& file)
{
    std::lock_guard lock(m_mutex);

    json raw;
    std::ifstream ifs(file);
    if (!ifs)
    {
        throw std::runtime_error("AppConfig: unable to open config file: "
                                 + file.string());
    }

    try
    {
        ifs >> raw;
    }
    catch (const json::parse_error& e)
    {
        throw std::runtime_error("AppConfig: JSON parse error in "
                                 + file.string() + " — " + e.what());
    }

    // Apply `${ENV}` variable expansion for all string values.
    // We need to traverse recursively.
    std::function<void(json&)> expand = [&](json& node)
    {
        if (node.is_object())
        {
            for (auto& [k, v] : node.items()) expand(v);
        }
        else if (node.is_array())
        {
            for (auto& v : node) expand(v);
        }
        else if (node.is_string())
        {
            std::string expanded = expandEnvVars(node.get_ref<const std::string&>());
            node = expanded;
        }
    };
    expand(raw);

    // Environment-driven overrides (top-level). We look for variables prefixed
    // with PF_ and reinterpret them as `"key":"value"` JSON pairs.
    json envOverrides = json::object();
    static const std::vector<std::string> keys = {
        "SERVER_HOST", "SERVER_PORT",
        "LOG_LEVEL",   "SCHEMA_PATH",
        "CACHE_TTL_SEC"
    };

#ifdef _WIN32
    // Windows: use GetEnvironmentStrings? for brevity we'll push-up just keys.
    for (const auto& k : keys)
    {
        if (const char* val = std::getenv(("PF_" + k).c_str()); val)
        {
            envOverrides[k] = val;
        }
    }
#else
    extern char **environ;
    for (char **current = environ; *current; ++current)
    {
        std::string ev(*current);
        auto pos = ev.find('=');
        if (pos == std::string::npos) continue;

        std::string key = ev.substr(0, pos);
        if (key.rfind("PF_", 0) == 0) // starts with PF_
        {
            envOverrides[key.substr(3)] = ev.substr(pos + 1);
        }
    }
#endif

    raw = merge(raw, envOverrides);

    // Deserialize to typed struct
    try
    {
        m_config = raw.get<Cfg>();
    }
    catch (const json::exception& e)
    {
        throw std::runtime_error(
            std::string("AppConfig: schema validation failed — ") + e.what());
    }

    // Additional semantic validation
    if (m_config.server.port == 0)
    {
        throw std::invalid_argument("AppConfig: server.port cannot be 0");
    }

    // Configure global logger once configuration is ready.
    configureLogger();
    spdlog::debug("AppConfig successfully loaded from {}", file.string());
}

const AppConfig::Cfg& AppConfig::get() const noexcept
{
    std::shared_lock lock(m_mutex);
    return m_config;
}

/*
 * Build sane defaults so the application runs even without an external
 * configuration file (useful in unit tests or local prototypes).
 */
AppConfig::Cfg AppConfig::buildDefaultConfig()
{
    Cfg cfg{};

    cfg.server.host = "0.0.0.0";
    cfg.server.port = 8080;

    cfg.monitoring.enabled   = true;
    cfg.monitoring.endpoint  = "/metrics";

    cfg.cache.enabled     = true;
    cfg.cache.ttl         = std::chrono::seconds{60};
    cfg.cache.maxEntries  = 50'000;

    cfg.schemaPath = "./schema.graphql";
    cfg.logLevel   = "info";
    cfg.version    = "v1";

    return cfg;
}

/*
 * Configure spdlog sink levels according to the config.
 */
void AppConfig::configureLogger() const
{
    spdlog::level::level_enum lvl;

    if      (m_config.logLevel == "trace")   lvl = spdlog::level::trace;
    else if (m_config.logLevel == "debug")   lvl = spdlog::level::debug;
    else if (m_config.logLevel == "info")    lvl = spdlog::level::info;
    else if (m_config.logLevel == "warn")    lvl = spdlog::level::warn;
    else if (m_config.logLevel == "error")   lvl = spdlog::level::err;
    else if (m_config.logLevel == "critical")lvl = spdlog::level::critical;
    else
    {
        spdlog::warn("Unknown log level '{}', defaulting to 'info'",
                     m_config.logLevel);
        lvl = spdlog::level::info;
    }

    spdlog::set_level(lvl);
    spdlog::set_pattern("[%Y-%m-%dT%H:%M:%S.%eZ] [%^%l%$] %v");
}

} // namespace paletteflux::app
```
