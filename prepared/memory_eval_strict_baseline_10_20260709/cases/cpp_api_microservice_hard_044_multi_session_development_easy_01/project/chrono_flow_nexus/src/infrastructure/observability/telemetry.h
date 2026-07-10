#pragma once
/******************************************************************************
 * ChronoFlow Nexus – Observability / Telemetry Facade
 *
 * This header provides a thin, compile-time-switchable abstraction over the
 * tracing, metrics, and structured-logging libraries used by ChronoFlow Nexus.
 *
 *   • Tracing   : OpenTelemetry C++ (`opentelemetry-cpp`)
 *   • Metrics   : OpenTelemetry Metrics API
 *   • Logging   : spdlog
 *
 * If any dependency is missing at build-time, safe stubs are compiled instead
 * so that the rest of the codebase remains oblivious to the concrete
 * instrumentation backend and the build still succeeds (albeit without
 * telemetry signals).
 *
 * The facade intentionally lives in a header to:
 *   1. Avoid an additional translation unit for every micro-service.
 *   2. Allow header-only inlining of small helper functions such as
 *      CFNX_SCOPED_SPAN, minimising call-stack pollution in hot paths.
 *
 * Author: ChronoFlow Nexus Core Team
 * SPDX-License-Identifier: MIT
 *****************************************************************************/

#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <unordered_map>

#if __has_include(<opentelemetry/trace/provider.h>)
#  define CFNX_HAS_OPENTELEMETRY 1
#  include <opentelemetry/context/runtime_context.h>
#  include <opentelemetry/metrics/provider.h>
#  include <opentelemetry/metrics/meter.h>
#  include <opentelemetry/trace/provider.h>
#  include <opentelemetry/trace/scope.h>
#else
#  define CFNX_HAS_OPENTELEMETRY 0
#endif

#if __has_include(<spdlog/spdlog.h>)
#  define CFNX_HAS_SPDLOG 1
#  include <spdlog/sinks/stdout_color_sinks.h>
#  include <spdlog/spdlog.h>
#else
#  define CFNX_HAS_SPDLOG 0
#endif

namespace cfnx::infrastructure::observability {

/*---------------------------------------------------------------------------*/
/* Telemetry Singleton                                                        */
/*---------------------------------------------------------------------------*/
class Telemetry final
{
public:
    /* Obtain global instance (thread-safe Meyers singleton). */
    static Telemetry &instance() noexcept
    {
        static Telemetry inst;
        return inst;
    }

    /* Idempotent initialiser. Safe to call multiple times from any thread. */
    void initialise(std::string service_name)
    {
        std::call_once(init_flag_, [this, &service_name] {
#if CFNX_HAS_SPDLOG
            // Console colour sink by default; can be replaced at runtime.
            logger_ = spdlog::stdout_color_mt("chrono_flow");
            logger_->set_level(spdlog::level::info);
            logger_->set_pattern("[%Y-%m-%d %H:%M:%S.%e] [%n] [%l] %v");
#endif

#if CFNX_HAS_OPENTELEMETRY
            tracer_ = opentelemetry::trace::Provider::GetTracerProvider()->GetTracer(
                service_name.data(), OPENTELEMETRY_SDK_VERSION);
            meter_ =
                opentelemetry::metrics::Provider::GetMeterProvider()->GetMeter(service_name);
#endif
            service_name_ = std::move(service_name);
        });
    }

    /* Structured / adaptable logger accessor. */
#if CFNX_HAS_SPDLOG
    std::shared_ptr<spdlog::logger> logger() noexcept { return logger_; }
#else
    struct NullLogger
    {
        template <typename... Args> void debug(Args &&...) noexcept {}
        template <typename... Args> void info(Args &&...) noexcept {}
        template <typename... Args> void warn(Args &&...) noexcept {}
        template <typename... Args> void error(Args &&...) noexcept {}
    };
    NullLogger logger() noexcept { return {}; }
#endif

#if CFNX_HAS_OPENTELEMETRY
    /*-------------------------------------------------------------------*/
    /* Tracing                                                            */
    /*-------------------------------------------------------------------*/
    opentelemetry::nostd::shared_ptr<opentelemetry::trace::Span>
    start_span(std::string_view name,
               const opentelemetry::trace::StartSpanOptions &opts = {})
    {
        if (!tracer_)
            return {};
        return tracer_->StartSpan(name, opts);
    }

    /*-------------------------------------------------------------------*/
    /* Metrics                                                            */
    /*-------------------------------------------------------------------*/
    opentelemetry::nostd::shared_ptr<opentelemetry::metrics::Histogram<double>>
    get_histogram(std::string_view name)
    {
        std::scoped_lock lk(metric_mutex_);
        auto it = histograms_.find(std::string(name));
        if (it != histograms_.end())
            return it->second;

        if (!meter_)
            return {};

        auto hist =
            meter_->CreateDoubleHistogram(std::string(name), "microseconds", "latency");
        histograms_.emplace(name, hist);
        return hist;
    }
#endif

private:
    Telemetry() = default;
    ~Telemetry() = default;

    std::once_flag init_flag_;
    std::string    service_name_;

#if CFNX_HAS_SPDLOG
    std::shared_ptr<spdlog::logger> logger_;
#endif

#if CFNX_HAS_OPENTELEMETRY
    opentelemetry::nostd::shared_ptr<opentelemetry::trace::Tracer> tracer_;
    opentelemetry::nostd::shared_ptr<opentelemetry::metrics::Meter> meter_;

    std::unordered_map<std::string,
                       opentelemetry::nostd::shared_ptr<opentelemetry::metrics::Histogram<double>>>
        histograms_;
    std::mutex metric_mutex_;
#endif
};

/*---------------------------------------------------------------------------*/
/* RAII Span – automatically ends on destruction and records exceptions       */
/*---------------------------------------------------------------------------*/
class ScopedSpan final
{
public:
#if CFNX_HAS_OPENTELEMETRY
    explicit ScopedSpan(std::string_view span_name)
        : span_{Telemetry::instance().start_span(span_name)}, scope_{span_}
    {
    }

    ~ScopedSpan()
    {
        if (!span_)
            return;

        /* If an unhandled exception is travelling up the stack, mark the span
         * as errored and attach the diagnostic information. */
        if (std::current_exception())
        {
            try
            {
                std::rethrow_exception(std::current_exception());
            }
            catch (const std::exception &ex)
            {
                span_->RecordException(ex);
                span_->SetStatus(opentelemetry::trace::StatusCode::kError, ex.what());
            }
            catch (...)
            {
                span_->SetStatus(opentelemetry::trace::StatusCode::kError,
                                 "Unknown exception");
            }
        }
        span_->End();
    }

    /* Access underlying span pointer for adding custom events/attributes. */
    auto get() const noexcept { return span_; }

private:
    opentelemetry::nostd::shared_ptr<opentelemetry::trace::Span> span_;
    opentelemetry::trace::Scope                                  scope_;
#else
    explicit ScopedSpan(std::string_view) {}
#endif
};

/*---------------------------------------------------------------------------*/
/* ScopedTimer – micro-benchmark utility wired into metrics                  */
/*---------------------------------------------------------------------------*/
class ScopedTimer final
{
public:
    using clock = std::chrono::steady_clock;

    explicit ScopedTimer(std::string metric_name)
        : metric_name_(std::move(metric_name)), start_(clock::now())
    {
    }

    ~ScopedTimer()
    {
        const auto elapsed =
            std::chrono::duration_cast<std::chrono::microseconds>(clock::now() - start_)
                .count();

#if CFNX_HAS_OPENTELEMETRY
        if (auto hist = Telemetry::instance().get_histogram(metric_name_))
            hist->Record(static_cast<double>(elapsed));
#endif

#if CFNX_HAS_SPDLOG
        Telemetry::instance().logger().debug("{}={}µs", metric_name_, elapsed);
#endif
    }

private:
    std::string      metric_name_;
    const clock::time_point start_;
};

/*---------------------------------------------------------------------------*/
/* Convenience Macros                                                        */
/*---------------------------------------------------------------------------*/
#if CFNX_HAS_OPENTELEMETRY
#  define CFNX_SCOPED_SPAN(name) ::cfnx::infrastructure::observability::ScopedSpan __cfnx_span{(name)}
#else
#  define CFNX_SCOPED_SPAN(name) (void)0
#endif

} // namespace cfnx::infrastructure::observability
