```cpp
/**
 *  PaletteFlux GraphQL Studio
 *  File:    paletteflux_studio/src/utils/Logger.cpp
 *
 *  A thin convenience wrapper around spdlog that centralises
 *  configuration, enforces sane defaults for the Studio’s micro-services,
 *  and provides a minimal compile-time fallback when spdlog is not
 *  available (unit-tests on CI, static-analysis, etc.).
 *
 *  NOTE: The interface for this module is declared in `Logger.h`.
 *  Only implementation details live here.
 */

#include "Logger.h"

#include <cstdlib>      // std::getenv
#include <filesystem>
#include <iostream>
#include <mutex>
#include <regex>
#include <sstream>
#include <string_view>

#if defined(PALETTEFLUX_DISABLE_SPDLOG)
// ‑----------------------------------------------------------------------
// Fallback implementation when spdlog is explicitly disabled.
//
// This keeps production code buildable in restricted environments while
// sacrificing coloured output, rotation, sinks, and most advanced
// features. The public interface remains compatible.
// ‑----------------------------------------------------------------------
namespace paletteflux::utils
{
namespace
{
    // shared dummy implementation
    class DummyLogger final : public std::enable_shared_from_this<DummyLogger>
    {
    public:
        template<typename... Args>
        void log([[maybe_unused]] spdlog::level::level_enum lvl,
                 [[maybe_unused]] std::string_view fmt,
                 [[maybe_unused]] Args &&... args) noexcept
        {
        }

        template<typename... Args>
        void trace([[maybe_unused]] std::string_view fmt, [[maybe_unused]] Args &&... args) noexcept {}
        template<typename... Args>
        void debug([[maybe_unused]] std::string_view fmt, [[maybe_unused]] Args &&... args) noexcept {}
        template<typename... Args>
        void info([[maybe_unused]] std::string_view fmt, [[maybe_unused]] Args &&... args) noexcept {}
        template<typename... Args>
        void warn([[maybe_unused]] std::string_view fmt, [[maybe_unused]] Args &&... args) noexcept {}
        template<typename... Args>
        void error([[maybe_unused]] std::string_view fmt, [[maybe_unused]] Args &&... args) noexcept {}
        template<typename... Args>
        void critical([[maybe_unused]] std::string_view fmt, [[maybe_unused]] Args &&... args) noexcept {}
    };
} // namespace

std::shared_ptr<DummyLogger> Logger::_root{std::make_shared<DummyLogger>()};

void Logger::init([[maybe_unused]] const InitOptions &opts) {}
void Logger::flush() noexcept {}
void Logger::setLevel([[maybe_unused]] spdlog::level::level_enum lvl) noexcept {}
void Logger::rotate([[maybe_unused]] std::size_t maxFileSize,
                    [[maybe_unused]] std::size_t maxFiles) noexcept
{
}
std::shared_ptr<spdlog::logger> Logger::get(std::string_view /*name*/) { return _root; }

} // namespace paletteflux::utils

#else
// ------------- Production implementation (with spdlog) -----------------
#include <spdlog/async.h>
#include <spdlog/sinks/rotating_file_sink.h>
#include <spdlog/sinks/stdout_color_sinks.h>
#include <spdlog/sinks/systemd_sink.h>
#include <spdlog/sinks/basic_file_sink.h>
#include <spdlog/fmt/ostr.h>

namespace paletteflux::utils
{
namespace
{
    constexpr std::string_view DEFAULT_PATTERN =
        "[%Y-%m-%d %H:%M:%S.%e] [%^%l%$] [%n] %v";

    std::filesystem::path make_default_log_path(std::string_view applicationName)
    {
        auto base = std::filesystem::current_path() / "logs";
        std::error_code ec;
        std::filesystem::create_directories(base, ec);
        return base / (std::string(applicationName) + ".log");
    }

    spdlog::level::level_enum parse_level(std::string_view lvl) noexcept
    {
        using namespace std::literals;
        static const std::unordered_map<std::string_view, spdlog::level::level_enum> table{
            {"trace"sv, spdlog::level::trace}, {"debug"sv, spdlog::level::debug},
            {"info"sv, spdlog::level::info},   {"warn"sv, spdlog::level::warn},
            {"error"sv, spdlog::level::err},   {"critical"sv, spdlog::level::critical},
            {"off"sv, spdlog::level::off}};
        auto it = table.find(lvl);
        return it == table.end() ? spdlog::level::info : it->second;
    }

    void install_signal_handlers()
    {
#ifdef _WIN32
        // On Windows the standard library already registers atexit handlers; no-op.
#else
        struct sigaction new_action {};
        new_action.sa_handler = [](int) {
            spdlog::shutdown();
            _Exit(EXIT_SUCCESS);
        };
        sigemptyset(&new_action.sa_mask);
        new_action.sa_flags = 0;

        sigaction(SIGTERM, &new_action, nullptr);
        sigaction(SIGINT, &new_action, nullptr);
#endif
    }
} // namespace

// ---------- static definitions -----------------------------------------
std::once_flag Logger::_initFlag;
std::string Logger::_applicationName;
std::shared_ptr<spdlog::logger> Logger::_root;
std::shared_ptr<spdlog::sinks::sink> Logger::_consoleSink;
std::shared_ptr<spdlog::sinks::sink> Logger::_fileSink;
std::mutex Logger::_registryMutex;

// -----------------------------------------------------------------------
void Logger::init(const InitOptions &opts)
{
    std::call_once(_initFlag, [opts]() {
        _applicationName = opts.applicationName.empty() ? "paletteflux" : opts.applicationName;

        // Determine log level
        std::string levelEnv =
            opts.overrideLevel.empty() ? (std::getenv("PALETTEFLUX_LOG_LEVEL") ?: "") : opts.overrideLevel;
        const auto level = levelEnv.empty() ? opts.defaultLevel : parse_level(levelEnv);

        // Build sinks
        spdlog::sinks_init_list sinkList;
        if (opts.enableConsole)
        {
            _consoleSink = std::make_shared<spdlog::sinks::stdout_color_sink_mt>();
            _consoleSink->set_level(level);
            sinkList.push_back(_consoleSink);
        }

        const std::filesystem::path logPath =
            opts.logFile.empty() ? make_default_log_path(_applicationName) : opts.logFile;

        try
        {
            _fileSink = std::make_shared<spdlog::sinks::rotating_file_sink_mt>(
                logPath.string(), opts.rotateEveryBytes, opts.maxFiles);
        }
        catch (const spdlog::spdlog_ex &ex)
        {
            // Fallback to basic sink if rotating sink fails (e.g. on read-only FS)
            std::cerr << "Failed to create rotating_file_sink: " << ex.what()
                      << "\nFalling back to basic_file_sink\n";
            _fileSink = std::make_shared<spdlog::sinks::basic_file_sink_mt>(logPath.string(), true);
        }
        _fileSink->set_level(level);
        sinkList.push_back(_fileSink);

        // Root logger
        _root = std::make_shared<spdlog::logger>(_applicationName, sinkList);
        _root->set_level(level);
        _root->set_pattern(std::string(DEFAULT_PATTERN));

        // Register and make it the default
        spdlog::register_logger(_root);
        spdlog::set_default_logger(_root);
        spdlog::flush_on(spdlog::level::err);
        spdlog::flush_every(std::chrono::seconds(opts.flushEverySeconds));

        _root->info("Logger initialised for {} (pid={})", _applicationName, ::getpid());

        // clean shutdown
        std::atexit([] {
            try
            {
                spdlog::shutdown();
            }
            catch (...)
            {
                // ignore
            }
        });

        install_signal_handlers();
    });
}

void Logger::flush() noexcept
{
    if (_root) _root->flush();
}

void Logger::setLevel(spdlog::level::level_enum newLevel) noexcept
{
    if (!_root) return;
    _root->set_level(newLevel);

    // propagate to sinks
    if (_consoleSink) _consoleSink->set_level(newLevel);
    if (_fileSink) _fileSink->set_level(newLevel);
}

void Logger::rotate(std::size_t maxFileSize, std::size_t maxFiles) noexcept
{
    std::lock_guard lk{_registryMutex};
    if (auto *rotatingSink = dynamic_cast<spdlog::sinks::rotating_file_sink_mt *>(_fileSink.get()))
    {
        rotatingSink->set_max_files(maxFiles);
        rotatingSink->set_max_size(maxFileSize);
        _root->info("Log rotation updated → size={}B, files={}", maxFileSize, maxFiles);
    }
}

std::shared_ptr<spdlog::logger> Logger::get(std::string_view name)
{
    if (name.empty() || name == _applicationName) return _root;

    std::lock_guard lk{_registryMutex};
    if (auto existing = spdlog::get(std::string(name))) { return existing; }

    auto logger = std::make_shared<spdlog::logger>(std::string(name),
                                                   spdlog::sinks_init_list{_consoleSink, _fileSink});
    logger->set_pattern(std::string(DEFAULT_PATTERN));
    logger->set_level(_root ? _root->level() : spdlog::level::info);

    spdlog::register_logger(logger);
    return logger;
}

} // namespace paletteflux::utils
#endif // PALETTEFLUX_DISABLE_SPDLOG
```