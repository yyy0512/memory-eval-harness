#pragma once
/**
 *  File:       AppConfig.h
 *  Project:    PaletteFlux GraphQL Studio
 *  Author:     PaletteFlux Core Team
 *
 *  Description:
 *  ------------
 *  The AppConfig class provides a **read-only, thread-safe, globally accessible**
 *  view of runtime configuration options for the PaletteFlux GraphQL Studio
 *  application.  Configuration is sourced from a JSON document on disk, then
 *  optionally overridden by environment variables to simplify container-based
 *  deployments (e.g., Kubernetes ConfigMaps/Secrets).
 *
 *  Typical Configuration File (config/studio.json):
 *  {
 *      "environment": "production",
 *      "port":        5180,
 *      "db": {
 *          "connection": "postgres://studio:***@pg-primary:5432/paletteflux"
 *      },
 *      "logging": {
 *          "level": "warn"
 *      },
 *      "features": {
 *          "monitoring": true,
 *          "pagination": true,
 *          "api_documentation": false
 *      },
 *      "cache": {
 *          "ttl_ms": 30000
 *      }
 *  }
 *
 *  Usage:
 *  ------
 *      // Process startup
 *      AppConfig::load("/etc/paletteflux/studio.json");
 *
 *      // Anywhere else
 *      auto& cfg = AppConfig::instance();
 *      spdlog::set_level(cfg.logLevel());
 *      if (cfg.featureEnabled("monitoring")) { enableMonitoring(); }
 */

#include <atomic>
#include <chrono>
#include <cstdlib>      // std::getenv
#include <fstream>
#include <mutex>
#include <shared_mutex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>

#include <nlohmann/json.hpp>

namespace paletteflux::studio
{
class AppConfig final
{
public:
    /* ---------- Public Types ------------------------------------------------ */
    enum class Environment
    {
        Development,
        Staging,
        Production
    };

    /* ---------- Singleton access ------------------------------------------- */
    /**
     * Throws std::logic_error if load() has not been invoked.
     */
    static const AppConfig& instance()
    {
        if (!s_loaded.load(std::memory_order_acquire))
            throw std::logic_error(
                "AppConfig::instance() called before AppConfig::load()");
        return s_instance;
    }

    /**
     * Bootstrap the configuration.  This must be called **exactly once** during
     * process start-up (e.g., from main()) before any other PaletteFlux
     * components are initialized.
     *
     * thread-safe: yes (double-checked locking).
     *
     * @param filePath     Absolute or relative path to JSON config file.
     * @param fallbackEnv  Environment that will be assumed when neither
     *                     configuration file nor environment variable
     *                     specifies "environment".
     *
     * Exceptions:
     *   std::runtime_error on I/O failure or malformed JSON.
     */
    static void load(const std::string& filePath,
                     Environment       fallbackEnv = Environment::Development)
    {
        // Fast path: already loaded
        if (s_loaded.load(std::memory_order_acquire)) { return; }

        // Acquire lock only during first initialization
        std::lock_guard<std::mutex> lk(s_loadMutex);
        if (s_loaded.load(std::memory_order_relaxed)) { return; } // double-check

        // Read file into JSON object (allowing empty file if we rely purely on
        // environment variables).
        nlohmann::json root;
        if (!filePath.empty())
        {
            std::ifstream f(filePath);
            if (!f)
            {
                throw std::runtime_error(
                    "AppConfig::load(): cannot open config file: " + filePath);
            }
            try
            {
                f >> root;
            }
            catch (const std::exception& ex)
            {
                throw std::runtime_error("AppConfig::load(): invalid JSON in " +
                                         filePath + ": " + ex.what());
            }
        }

        // Delegate parsing to private instance
        s_instance.parseJson(root, fallbackEnv);
        s_loaded.store(true, std::memory_order_release);
    }

    /* ---------- Accessors --------------------------------------------------- */
    Environment environment() const noexcept { return m_env; }
    int         httpPort()   const noexcept { return m_httpPort; }
    std::string dbConnectionString() const noexcept { return m_dbConn; }

    /**
     * logLevel() returns a lowercase string representation such as
     * "trace", "debug", "info", "warn", "error".
     */
    std::string             logLevel() const noexcept { return m_logLevel; }
    std::chrono::milliseconds
                            cacheTtl() const noexcept { return m_cacheTtl; }

    /**
     * Query for arbitrary feature flag.  Returns false if the key is unknown.
     */
    bool featureEnabled(std::string_view key) const
    {
        const auto it = m_featureFlags.find(std::string(key));
        return it != m_featureFlags.end() && it->second;
    }

    /* ---------- Convenience ------------------------------------------------- */
    static constexpr std::string_view version() noexcept
    {
        return "1.4.2"; // updated via CI/CD pipeline
    }

private:
    /* ---------- Data Members ------------------------------------------------ */
    Environment                         m_env         = Environment::Development;
    int                                 m_httpPort    = 5180;
    std::string                         m_dbConn      = "postgres://localhost";
    std::string                         m_logLevel    = "info";
    std::unordered_map<std::string, bool>
                                        m_featureFlags{};
    std::chrono::milliseconds           m_cacheTtl{60000};

    /* ---------- Singleton plumbing ----------------------------------------- */
    AppConfig()  = default;
    ~AppConfig() = default;

    AppConfig(const AppConfig&)            = delete;
    AppConfig& operator=(const AppConfig&) = delete;

    static AppConfig         s_instance;
    static std::atomic_bool  s_loaded;
    static std::mutex        s_loadMutex;

    /* ---------- Helpers ----------------------------------------------------- */
    static Environment envFromString(std::string_view sv)
    {
        if (sv == "dev" || sv == "development")   return Environment::Development;
        if (sv == "staging")                      return Environment::Staging;
        if (sv == "prod" || sv == "production")   return Environment::Production;
        throw std::invalid_argument(
            "AppConfig: unknown environment string: " + std::string(sv));
    }

    static std::string envToString(Environment e)
    {
        switch (e)
        {
        case Environment::Development: return "development";
        case Environment::Staging:     return "staging";
        default:                       return "production";
        }
    }

    /**
     * Replace configuration values with overrides pulled from environment
     * variables.  Naming scheme:
     *      PF_ENV           -> environment          (development|staging|production)
     *      PF_PORT          -> http port            (int)
     *      PF_DB_CONN       -> database connection  (string)
     *      PF_LOG_LEVEL     -> trace|debug|info|...
     *      PF_CACHE_TTL_MS  -> milliseconds
     *      PF_FF_<FEATURE>  -> "1" or "0"
     */
    void applyEnvOverrides()
    {
        if (const char* v = std::getenv("PF_ENV")) { m_env = envFromString(v); }

        if (const char* v = std::getenv("PF_PORT")) { m_httpPort = std::atoi(v); }

        if (const char* v = std::getenv("PF_DB_CONN")) { m_dbConn = v; }

        if (const char* v = std::getenv("PF_LOG_LEVEL")) { m_logLevel = v; }

        if (const char* v = std::getenv("PF_CACHE_TTL_MS"))
        {
            m_cacheTtl = std::chrono::milliseconds(std::atoi(v));
        }

        // Iterate through PF_FF_*
        extern char** environ;
        for (char** env = environ; *env != nullptr; ++env)
        {
            std::string_view line(*env);
            constexpr std::string_view prefix = "PF_FF_";
            if (!line.starts_with(prefix)) continue;
            auto eqPos = line.find('=');
            if (eqPos == std::string_view::npos) continue;
            std::string key(line.substr(prefix.size(), eqPos - prefix.size()));
            std::string value(line.substr(eqPos + 1));
            m_featureFlags[key] = (value == "1" || value == "true");
        }
    }

    /**
     * Parse JSON tree and fill member variables.  Any missing properties will
     * fall back to sensible defaults (see declaration above) or environment
     * variables.
     *
     * @param root JSON root node (may be empty)
     */
    void parseJson(const nlohmann::json& root, Environment fallbackEnv)
    {
        try
        {
            // 1. environment
            if (root.contains("environment"))
            {
                m_env = envFromString(root.at("environment").get<std::string>());
            }
            else { m_env = fallbackEnv; }

            // 2. port
            if (root.contains("port")) { m_httpPort = root.at("port"); }

            // 3. db.connection
            if (root.contains("db") && root["db"].contains("connection"))
            {
                m_dbConn = root["db"]["connection"];
            }

            // 4. logging.level
            if (root.contains("logging") && root["logging"].contains("level"))
            {
                m_logLevel = root["logging"]["level"];
            }

            // 5. cache.ttl_ms
            if (root.contains("cache") && root["cache"].contains("ttl_ms"))
            {
                m_cacheTtl = std::chrono::milliseconds(
                    root["cache"]["ttl_ms"].get<int>());
            }

            // 6. features
            if (root.contains("features") && root["features"].is_object())
            {
                for (auto it = root["features"].begin();
                     it != root["features"].end(); ++it)
                {
                    m_featureFlags[it.key()] = it.value().get<bool>();
                }
            }
        }
        catch (const std::exception& ex)
        {
            throw std::runtime_error(std::string("AppConfig: ") + ex.what());
        }

        // 7. overlay environment variable overrides (highest precedence)
        applyEnvOverrides();
    }
};

/* ---------- Static data member definitions -------------------------------- */
inline AppConfig        AppConfig::s_instance;
inline std::atomic_bool AppConfig::s_loaded{false};
inline std::mutex       AppConfig::s_loadMutex;

} // namespace paletteflux::studio