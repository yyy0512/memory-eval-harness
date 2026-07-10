#include "config_loader.h"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <regex>
#include <shared_mutex>
#include <stdexcept>
#include <string_view>

#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>

namespace chrono_flow_nexus::infrastructure::config {

using nlohmann::json;
namespace fs = std::filesystem;

// -------------------------------------------------------------------------------------------------
// Utilities
// -------------------------------------------------------------------------------------------------

namespace {

// Split a UTF-8 string on a single character delimiter.
// Delimiter is not included in the result.
std::vector<std::string_view> split(std::string_view text, char delimiter) {
    std::vector<std::string_view> parts;
    size_t start = 0;
    auto end = text.find(delimiter, start);
    while (end != std::string_view::npos) {
        parts.emplace_back(text.substr(start, end - start));
        start = end + 1;
        end = text.find(delimiter, start);
    }
    parts.emplace_back(text.substr(start));
    return parts;
}

// Convert a CFNEXUS_ style environment variable into a dotted config path.
// E.g. CFNEXUS_DATABASE__HOST => "database.host"
std::string envToPath(std::string_view envKey, std::string_view servicePrefix) {
    // Remove the prefix (`CFNEXUS_`)
    envKey.remove_prefix(servicePrefix.size());

    std::string path;
    path.reserve(envKey.size());

    auto tokens = split(envKey, '_');
    for (auto&& token : tokens) {
        if (token.empty()) continue;

        if (token == "") continue;
        if (token == token.find("__") != std::string_view::npos) {
            // double underscore acts as nesting delimiter
            for (char c : token) {
                if (c == '_') continue;
                path.push_back(static_cast<char>(::tolower(c)));
            }
            path.push_back('.');
        } else {
            for (char c : token) {
                path.push_back(static_cast<char>(::tolower(c)));
            }
            path.push_back('.');
        }
    }
    if (!path.empty() && path.back() == '.') path.pop_back();
    return path;
}

#ifdef _WIN32
// On Windows, fetch environment via GetEnvironmentStrings.
#include <windows.h>
std::vector<std::string> collectEnvironment() {
    std::vector<std::string> out;
    LPCH envStrings = GetEnvironmentStringsA();
    if (!envStrings) return out;

    for (LPCH current = envStrings; *current; ) {
        std::string var(current);
        out.push_back(std::move(var));
        current += out.back().size() + 1;
    }

    FreeEnvironmentStringsA(envStrings);
    return out;
}
#else
extern char **environ;
std::vector<std::string> collectEnvironment() {
    std::vector<std::string> out;
    for (char **env = environ; *env; ++env) {
        out.emplace_back(*env);
    }
    return out;
}
#endif

// Traverse or create nested JSON nodes given a dotted path.
// Returns reference to the final node.
json& findOrCreate(json& root, const std::string& dottedPath) {
    auto parts = split(dottedPath, '.');
    json* current = &root;
    for (auto it = parts.begin(); it != parts.end(); ++it) {
        auto key = std::string(*it);
        if (it + 1 == parts.end()) {
            // Leaf.
            return (*current)[key];
        }

        if (!current->contains(key) || !(*current)[key].is_object()) {
            (*current)[key] = json::object();
        }
        current = &((*current)[key]);
    }
    return *current;  // unreachable
}

} // namespace

// -------------------------------------------------------------------------------------------------
// ConfigLoader Implementation
// -------------------------------------------------------------------------------------------------

ConfigLoader::ConfigLoader(Options options)
    : _options(std::move(options)) {}

void ConfigLoader::initialize() {
    std::unique_lock lock(_mutex);

    loadFromFile(lock);
    mergeEnvironmentVariables(lock);

    _initialized = true;
}

void ConfigLoader::reload() {
    std::unique_lock lock(_mutex);

    if (!_initialized) {
        throw std::logic_error("ConfigLoader::reload() called before initialize()");
    }

    // See if the underlying file has changed.
    if (!_options.path.empty()) {
        std::error_code ec;
        auto currentWriteTime = fs::last_write_time(_options.path, ec);
        if (!ec && currentWriteTime != _lastWriteTime) {
            spdlog::info("Configuration file change detected: reloading '{}'",
                         _options.path.string());
            loadFromFile(lock);
        }
    }

    mergeEnvironmentVariables(lock);
}

void ConfigLoader::loadFromFile(const std::unique_lock<std::shared_mutex>& lock) {
    if (_options.path.empty()) {
        spdlog::warn("ConfigLoader: no config file path set—skipping file load");
        _config = json::object();
        return;
    }

    std::ifstream in(_options.path);
    if (!in.is_open()) {
        spdlog::warn("ConfigLoader: could not open config file '{}'", _options.path.string());
        _config = json::object();
        return;
    }

    try {
        json fileConfig = json::parse(in, nullptr, true, /*allow_exceptions=*/true);
        _config = std::move(fileConfig);
        _lastWriteTime = fs::last_write_time(_options.path);
        spdlog::info("Loaded configuration file '{}'", _options.path.string());
    } catch (const json::parse_error& ex) {
        spdlog::error("ConfigLoader: failed to parse JSON config file '{}': {}",
                      _options.path.string(), ex.what());
        throw;
    }
}

void ConfigLoader::mergeEnvironmentVariables(
    const std::unique_lock<std::shared_mutex>& /*lock*/) {
    constexpr std::string_view PREFIX = "CFNEXUS_";

    for (const auto& entry : collectEnvironment()) {
        auto pos = entry.find('=');
        if (pos == std::string::npos) continue;

        std::string_view key(entry.c_str(), pos);
        if (!key.starts_with(PREFIX)) continue;

        std::string_view value(entry.c_str() + pos + 1);

        // Interpret dotted path and override
        auto path = envToPath(key, PREFIX);
        if (path.empty()) continue;

        json& node = findOrCreate(_config, path);

        // Try to interpret the value.
        if (value == "true" || value == "false") {
            node = (value == "true");
        } else {
            // Attempt to parse numeric values, otherwise string.
            char* endPtr = nullptr;
            long long intValue = std::strtoll(value.data(), &endPtr, 10);
            if (endPtr != value.data() && *endPtr == '\0') {
                node = intValue;
            } else {
                double dblValue = std::strtod(value.data(), &endPtr);
                if (endPtr != value.data() && *endPtr == '\0') {
                    node = dblValue;
                } else {
                    node = std::string(value);
                }
            }
        }
    }
}

// Thread-safe read-only getter with dotted path.
json ConfigLoader::getRaw(std::string_view path) const {
    std::shared_lock lock(_mutex);

    const json* current = &_config;
    for (auto segment : split(path, '.')) {
        if (!current->is_object() || !current->contains(std::string(segment))) {
            throw std::out_of_range(
                fmt::format("Config key '{}' not found in configuration", path));
        }
        current = &((*current)[std::string(segment)]);
    }
    return *current;  // copy, thread safe
}

// Explicit template instantiations for the most common types.
// Template definition lives in header to allow custom types.
template int ConfigLoader::get<int>(std::string_view) const;
template double ConfigLoader::get<double>(std::string_view) const;
template bool ConfigLoader::get<bool>(std::string_view) const;
template std::string ConfigLoader::get<std::string>(std::string_view) const;
template nlohmann::json ConfigLoader::get<nlohmann::json>(std::string_view) const;

} // namespace chrono_flow_nexus::infrastructure::config