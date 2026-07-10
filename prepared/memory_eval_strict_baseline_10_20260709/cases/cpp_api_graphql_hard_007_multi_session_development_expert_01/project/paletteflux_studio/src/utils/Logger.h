```cpp
/************************************************************************************
 * PaletteFlux GraphQL Studio – Logger Utility
 *
 * File:    paletteflux_studio/src/utils/Logger.h
 * Author:  PaletteFlux Engineering
 * License: MIT
 *
 * A minimal-dependency, production-grade logging utility designed for
 *   • low runtime overhead via compile-time log-level stripping
 *   • thread-safety
 *   • dual console / file sinks
 *   • easy-to-use streaming macros
 *
 * Usage:
 *      PAL_INFO("Server started on port " << port);
 *
 *      // Change global settings at bootstrap:
 *      paletteflux::utils::Logger::instance()
 *          .setLogLevel(paletteflux::utils::LogLevel::Debug)
 *          .setLogFile("/var/log/paletteflux/api.log")
 *          .enableConsoleColors(false);
 *
 ************************************************************************************/

#pragma once

#include <atomic>
#include <chrono>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <utility>

namespace paletteflux::utils {

//----------------------------------------------------------------------------//
// Compile-time log–level configuration                                       //
//----------------------------------------------------------------------------//

/*
 * To permanently strip lower-priority log-messages from the binary, define
 *   PF_COMPILED_LOG_LEVEL
 * before including this header (e.g. via compiler flags –DPF_COMPILED_LOG_LEVEL=3)
 *
 * Severity order (low → high):
 *      Trace(0)  Debug(1)  Info(2)  Warn(3)  Error(4)  Critical(5)  Off(6)
 */
#ifndef PF_COMPILED_LOG_LEVEL
#   define PF_COMPILED_LOG_LEVEL 0   // default to Trace
#endif

//----------------------------------------------------------------------------//
// Log-level declaration                                                     //
//----------------------------------------------------------------------------//

enum class LogLevel : int {
    Trace    = 0,
    Debug    = 1,
    Info     = 2,
    Warn     = 3,
    Error    = 4,
    Critical = 5,
    Off      = 6
};

// String representation helper
inline const char* toString(LogLevel level) noexcept {
    switch (level) {
        case LogLevel::Trace:    return "TRACE";
        case LogLevel::Debug:    return "DEBUG";
        case LogLevel::Info:     return "INFO ";
        case LogLevel::Warn:     return "WARN ";
        case LogLevel::Error:    return "ERROR";
        case LogLevel::Critical: return "CRIT ";
        default:                 return "UNKWN";
    }
}

//----------------------------------------------------------------------------//
// Logger (singleton)                                                         //
//----------------------------------------------------------------------------//

class Logger final
{
public:
    // Retrieve the globally shared logger instance.
    static Logger& instance() noexcept {
        static Logger inst;
        return inst;
    }

    // Fluent configuration helpers (thread-safe).
    Logger& setLogLevel(LogLevel level) noexcept {
        _level.store(static_cast<int>(level), std::memory_order_relaxed);
        return *this;
    }

    Logger& enableConsoleLogging(bool enable = true) noexcept {
        _consoleEnabled.store(enable, std::memory_order_relaxed);
        return *this;
    }

    Logger& enableConsoleColors(bool enable = true) noexcept {
        _colorEnabled.store(enable, std::memory_order_relaxed);
        return *this;
    }

    /*
     * Sets / switches the active log-file.
     * The method will attempt to open the file immediately and
     * throw std::runtime_error on failure (callers should handle this during
     * app initialisation).
     */
    Logger& setLogFile(const std::string& path,
                       bool truncate = false,
                       bool flushImmediately = false)
    {
        std::lock_guard<std::mutex> lock(_sinkMutex);

        std::ios_base::openmode mode = std::ios::out | std::ios::app;
        if (truncate) mode = std::ios::out | std::ios::trunc;

        std::unique_ptr<std::ofstream> newFile =
            std::make_unique<std::ofstream>(path, mode);

        if (!newFile->is_open()) {
            throw std::runtime_error("Logger: Unable to open log-file \"" + path + '"');
        }

        _fileSink.swap(newFile);
        _fileFlushImmediate.store(flushImmediately, std::memory_order_relaxed);
        return *this;
    }

    // Core logging entry point (used by macros).
    void log(LogLevel level,
             std::string message,
             const char* file,
             int         line,
             const char* function)
    {
        if (static_cast<int>(level) < _level.load(std::memory_order_relaxed)) {
            return; // run-time filtration
        }

        const std::string ts = buildTimestamp();
        const std::string location = buildLocation(file, line, function);
        const bool colorize = _colorEnabled.load(std::memory_order_relaxed);

        const std::string formatted =
            format(ts, level, message, location, colorize);

        // Dispatch to sinks
        if (_consoleEnabled.load(std::memory_order_relaxed)) {
            writeConsole(formatted, colorize);
        }
        writeFile(formatted);
    }

    // Non-copyable / non-movable
    Logger(const Logger&)            = delete;
    Logger& operator=(const Logger&) = delete;
    Logger(Logger&&)                 = delete;
    Logger& operator=(Logger&&)      = delete;

private:
    Logger()
        : _level(static_cast<int>(LogLevel::Info)),
          _consoleEnabled(true),
          _colorEnabled(true),
          _fileFlushImmediate(false)
    {}

    ~Logger() = default;

    // Timestamp in ISO-8601 with milliseconds, UTC
    static std::string buildTimestamp()
    {
        using namespace std::chrono;

        const auto now   = system_clock::now();
        const auto secs  = time_point_cast<std::chrono::seconds>(now);
        const auto ms    = duration_cast<milliseconds>(now - secs).count();

        std::time_t       tt  = system_clock::to_time_t(secs);
#if defined(_WIN32)
        std::tm           tm;
        gmtime_s(&tm, &tt);
#else
        std::tm           tm;
        gmtime_r(&tt, &tm);
#endif
        std::ostringstream oss;
        oss << std::put_time(&tm, "%Y-%m-%dT%H:%M:%S")
            << '.' << std::setfill('0') << std::setw(3) << ms << "Z";
        return oss.str();
    }

    // Minimal location string (file:line function)
    static std::string buildLocation(const char* file, int line, const char* func)
    {
        std::ostringstream oss;
        oss << file << ':' << line << ' ' << func;
        return oss.str();
    }

    // Apply ANSI coloring by severity (if enabled and target is a TTY)
    static const char* colorCode(LogLevel lvl) noexcept {
        switch (lvl) {
            case LogLevel::Trace:    return "\033[90m"; // bright black
            case LogLevel::Debug:    return "\033[36m"; // cyan
            case LogLevel::Info:     return "\033[32m"; // green
            case LogLevel::Warn:     return "\033[33m"; // yellow
            case LogLevel::Error:    return "\033[31m"; // red
            case LogLevel::Critical: return "\033[41m"; // white on red
            default:                 return "";
        }
    }

    static constexpr const char* ANSI_RESET = "\033[0m";

    static std::string format(const std::string& timestamp,
                              LogLevel          level,
                              const std::string& msg,
                              const std::string& location,
                              bool              colorize)
    {
        std::ostringstream oss;
        if (colorize) oss << colorCode(level);
        oss << '[' << timestamp << ']'
            << '[' << toString(level) << "] "
            << msg
            << " — " << location;
        if (colorize) oss << ANSI_RESET;
        return oss.str();
    }

    // Console sink
    static void writeConsole(const std::string& line, bool colorize)
    {
        // Use cerr for >= Error
        if (line.find("[ERROR") != std::string::npos ||
            line.find("[CRIT")  != std::string::npos)
        {
            std::lock_guard<std::mutex> lock(_consoleMutex());
            std::cerr << line << '\n';
        }
        else {
            std::lock_guard<std::mutex> lock(_consoleMutex());
            std::cout << line << '\n';
        }

        if (!colorize) {
            // Force flush when no colors (some terminals buffer)
            std::cout.flush();
            std::cerr.flush();
        }
    }

    // File sink (if configured)
    void writeFile(const std::string& line)
    {
        const std::lock_guard<std::mutex> lock(_sinkMutex);
        if (_fileSink && _fileSink->is_open()) {
            (*_fileSink) << line << '\n';
            if (_fileFlushImmediate.load(std::memory_order_relaxed)) {
                _fileSink->flush();
            }
        }
    }

    // Singleton-wide console-stream mutex
    static std::mutex& _consoleMutex() {
        static std::mutex mtx;
        return mtx;
    }

    // Members
    std::atomic<int>               _level;               // minimum severity
    std::atomic<bool>              _consoleEnabled;
    std::atomic<bool>              _colorEnabled;
    std::atomic<bool>              _fileFlushImmediate;

    std::mutex                     _sinkMutex;           // protects _fileSink
    std::unique_ptr<std::ofstream> _fileSink;
};

//----------------------------------------------------------------------------//
// Logging macros (streaming)                                                  //
//----------------------------------------------------------------------------//

/*  Internal helper – DO NOT USE DIRECTLY */
#define _PF_LOG_INTERNAL(lvl, msg)                                             \
    do {                                                                       \
        if ((lvl) >= PF_COMPILED_LOG_LEVEL) {                                  \
            std::ostringstream _pf_oss__;                                      \
            _pf_oss__ << msg;                                                  \
            ::paletteflux::utils::Logger::instance().log(                      \
                static_cast<::paletteflux::utils::LogLevel>(lvl),              \
                _pf_oss__.str(),                                               \
                __FILE__,                                                      \
                __LINE__,                                                      \
                __func__);                                                     \
        }                                                                      \
    } while (false)

// Public shortcuts
#define PAL_TRACE(msg)    _PF_LOG_INTERNAL(::paletteflux::utils::LogLevel::Trace,    msg)
#define PAL_DEBUG(msg)    _PF_LOG_INTERNAL(::paletteflux::utils::LogLevel::Debug,    msg)
#define PAL_INFO(msg)     _PF_LOG_INTERNAL(::paletteflux::utils::LogLevel::Info,     msg)
#define PAL_WARN(msg)     _PF_LOG_INTERNAL(::paletteflux::utils::LogLevel::Warn,     msg)
#define PAL_ERROR(msg)    _PF_LOG_INTERNAL(::paletteflux::utils::LogLevel::Error,    msg)
#define PAL_CRITICAL(msg) _PF_LOG_INTERNAL(::paletteflux::utils::LogLevel::Critical, msg)

//----------------------------------------------------------------------------//
} // namespace paletteflux::utils
//----------------------------------------------------------------------------//
```