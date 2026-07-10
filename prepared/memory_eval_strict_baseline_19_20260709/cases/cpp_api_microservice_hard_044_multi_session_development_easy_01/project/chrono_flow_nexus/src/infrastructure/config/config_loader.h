#ifndef CHRONO_FLOW_NEXUS_INFRASTRUCTURE_CONFIG_CONFIG_LOADER_H_
#define CHRONO_FLOW_NEXUS_INFRASTRUCTURE_CONFIG_CONFIG_LOADER_H_

/**
 * ChronoFlow Nexus
 * ----------------
 * Copyright (c) ChronoFlow
 *
 * SPDX-License-Identifier: MIT
 *
 * config_loader.h
 *
 * A minimal-dependency, header-only configuration facility used across the
 * micro-service.  Thread-safe, environment-variable aware, and reloadable at
 * runtime without requiring a full service restart.
 *
 * Example usage:
 *
 *     #include "infrastructure/config/config_loader.h"
 *
 *     using chrono_flow::infrastructure::config::ConfigLoader;
 *
 *     int main(int argc, char** argv) {
 *         ConfigLoader::instance().load("/etc/chrono_flow/config.json");
 *
 *         auto port = ConfigLoader::instance().get<std::uint16_t>("server.port");
 *         auto mongoUri = ConfigLoader::instance().get<std::string>("mongo.uri");
 *     }
 */

#include <shared_mutex>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <system_error>
#include <type_traits>
#include <utility>

#include <nlohmann/json.hpp>      // single-header JSON library
#include <spdlog/spdlog.h>        // logging facility (header-only when header-only build flag is enabled)

namespace chrono_flow::infrastructure::config {

class ConfigError : public std::runtime_error
{
public:
    explicit ConfigError(std::string msg)
        : std::runtime_error{ std::move(msg) }
    {}
};

/**
 * Singleton responsible for loading & serving configuration values.  The file
 * format is JSON, but individual keys can be overridden by environment
 * variables.  The mapping strategy for overrides is
 *
 *     "server.port"  ->  CHRONOFLOW_SERVER_PORT
 *
 * i.e.  prefix "CHRONOFLOW_" + upper-cased, dot-to-underscore key.
 */
class ConfigLoader final
{
public:
    // Non-copyable / non-movable
    ConfigLoader(const ConfigLoader&)            = delete;
    ConfigLoader& operator=(const ConfigLoader&) = delete;
    ConfigLoader(ConfigLoader&&)                 = delete;
    ConfigLoader& operator=(ConfigLoader&&)      = delete;

    /**
     * Fetch global instance.
     */
    [[nodiscard]] static ConfigLoader& instance() noexcept
    {
        static ConfigLoader loader;
        return loader;
    }

    /**
     * Load configuration from a JSON file.  May be called multiple times:
     *  • On first call the configuration is loaded.
     *  • On subsequent calls, when allow_reload == true, the configuration will
     *    be merged (override semantics) and made visible to all threads.
     *
     * Thread-safety guarantees:
     *  • Readers are never blocked by readers (shared).
     *  • A single writer (load / reload) obtains an exclusive lock.
     */
    void load(const std::filesystem::path& file,
              bool allow_reload = false)
    {
        std::unique_lock lock(_mutex);

        if (!_config.empty() && !allow_reload) {
            throw ConfigError{
                "Configuration already loaded.  Enable 'allow_reload' to reload."
            };
        }

        if (!std::filesystem::exists(file)) {
            throw ConfigError{ "Config file not found: " + file.string() };
        }

        std::ifstream inFile{ file };
        if (!inFile) {
            throw ConfigError{ "Failed to open config file: " + file.string() };
        }

        nlohmann::json newCfg;
        try {
            inFile >> newCfg;
        } catch (const nlohmann::json::parse_error& ex) {
            throw ConfigError{ "JSON parse error in config file '" + file.string() + "': " + ex.what() };
        }

        // Apply env overrides before storing internally.
        applyEnvironmentOverrides(newCfg);

        _config    = std::move(newCfg);
        _configRaw = file;

        _lastWriteTs = std::filesystem::last_write_time(file);

        spdlog::info("Loaded configuration from {}", file.string());
    }

    /**
     * Attempt to reload the configuration only when the underlying file has
     * changed on disk.  This can be wired into a timer or SIGHUP handler.
     */
    void reloadIfModified()
    {
        std::error_code ec;
        auto ts = std::filesystem::last_write_time(_configRaw, ec);
        if (ec) {
            spdlog::warn("Unable to stat config file '{}': {}", _configRaw.string(), ec.message());
            return;
        }

        std::shared_lock rlock(_mutex);
        bool modified = ts != _lastWriteTs;
        rlock.unlock();

        if (modified) {
            spdlog::info("Config file '{}' changed on disk, reloading …", _configRaw.string());
            load(_configRaw, /*allow_reload*/ true);
        }
    }

    /**
     * Retrieve a value and cast/convert to the desired type T.
     * T must be constructible from the underlying JSON value.
     *
     * Example:
     *     auto timeout = cfg.get<std::chrono::milliseconds>("network.timeout_ms");
     */
    template <typename T>
    [[nodiscard]] T get(const std::string& dottedKey) const
    {
        std::shared_lock lock(_mutex);
        const nlohmann::json* node = locate(dottedKey);

        if (node == nullptr || node->is_null()) {
            throw ConfigError{ "Missing configuration key: " + dottedKey };
        }

        try {
            return node->get<T>();
        } catch (const nlohmann::json::type_error& ex) {
            throw ConfigError{
                "Configuration key '" + dottedKey + "' has incompatible type: " + std::string{ ex.what() }
            };
        }
    }

    /**
     * Retrieve a value but fallback to 'defaultValue' when absent.  Does not
     * throw if the key is missing, still throws on type mismatch.
     */
    template <typename T>
    [[nodiscard]] T getOr(const std::string& dottedKey, T defaultValue) const
    {
        std::shared_lock lock(_mutex);
        const nlohmann::json* node = locate(dottedKey);
        if (node == nullptr || node->is_null()) {
            return defaultValue;
        }

        try {
            return node->get<T>();
        } catch (const nlohmann::json::type_error& ex) {
            throw ConfigError{
                "Configuration key '" + dottedKey + "' has incompatible type: " + std::string{ ex.what() }
            };
        }
    }

    /**
     * Check if a key exists (null counts as existing).
     */
    [[nodiscard]] bool has(const std::string& dottedKey) const
    {
        std::shared_lock lock(_mutex);
        return locate(dottedKey) != nullptr;
    }

    /**
     * Convert entire config object to JSON.  Useful for debugging / metrics.
     */
    [[nodiscard]] nlohmann::json dump() const
    {
        std::shared_lock lock(_mutex);
        return _config;
    }

private:
    ConfigLoader()  = default;
    ~ConfigLoader() = default;

    /**
     * Return pointer to JSON node or null when path not present.
     * Accepts dotted syntax, e.g. "server.tls.port"
     */
    const nlohmann::json* locate(const std::string& dottedKey) const
    {
        const nlohmann::json* node = &_config;
        std::size_t           pos  = 0;
        std::size_t           dot;

        while ((dot = dottedKey.find('.', pos)) != std::string::npos) {
            auto token = dottedKey.substr(pos, dot - pos);
            if (!node->contains(token)) {
                return nullptr;
            }
            node = &(*node)[token];
            pos  = dot + 1;
        }

        auto lastToken = dottedKey.substr(pos);
        if (!node->contains(lastToken)) {
            return nullptr;
        }
        return &(*node)[lastToken];
    }

    /**
     * Iterate over keys and override with env vars when available.
     */
    static void applyEnvironmentOverrides(nlohmann::json& cfg)
    {
        for (auto& [key, value] : cfg.items()) {
            applyEnvRecursive("CHRONOFLOW_" + key, value);
        }
    }

    static void applyEnvRecursive(const std::string& envPrefix, nlohmann::json& node)
    {
        if (node.is_object()) {
            for (auto& [childKey, childValue] : node.items()) {
                applyEnvRecursive(envPrefix + "_" + toEnvKey(childKey), childValue);
            }
            return;
        }

        // Leaf node
        const char* envVal = std::getenv(envPrefix.c_str());
        if (envVal == nullptr) {
            return;
        }

        try {
            // Convert string env value into appropriate JSON type
            if (node.is_boolean()) {
                std::string v{ envVal };
                std::transform(v.begin(), v.end(), v.begin(), ::tolower);
                node = (v == "1" || v == "true" || v == "yes");
            } else if (node.is_number_integer()) {
                node = std::stoll(envVal);
            } else if (node.is_number_float()) {
                node = std::stod(envVal);
            } else {
                node = std::string{ envVal };
            }
            spdlog::info("Overrode config key using ENV {}='{}'", envPrefix, envVal);
        } catch (const std::exception& ex) {
            spdlog::warn("Failed to parse env var {}='{}': {}", envPrefix, envVal, ex.what());
        }
    }

    /**
     * Transform arbitrary key into ENV compatible token:
     *     "listen-address" -> "LISTEN_ADDRESS"
     */
    static std::string toEnvKey(std::string key)
    {
        for (char& c : key) {
            if (c == '-' || c == '.') {
                c = '_';
            } else {
                c = static_cast<char>(::toupper(c));
            }
        }
        return key;
    }

private:
    mutable std::shared_mutex _mutex;

    nlohmann::json           _config;       // current live config
    std::filesystem::path    _configRaw;    // path to underlying file
    std::filesystem::file_time_type _lastWriteTs{};
};

}   // namespace chrono_flow::infrastructure::config

#endif   // CHRONO_FLOW_NEXUS_INFRASTRUCTURE_CONFIG_CONFIG_LOADER_H_
