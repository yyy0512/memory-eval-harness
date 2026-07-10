```cpp
/**
 * chrono_flow_nexus/src/infrastructure/observability/telemetry.cpp
 *
 * High-level observability bootstrap for ChronoFlow Nexus.
 *
 * This translation unit wires up OpenTelemetry for distributed tracing and
 * metrics, exposes a thin RAII span helper, and offers convenience
 * accessors for counters, histograms, and gauges that are safe to call from
 * any thread in the application.
 *
 * The implementation deliberately hides all OpenTelemetry specifics from
 * the rest of the codebase:  higher layers only depend on the header
 * interface (telemetry.h) and therefore remain swappable and easy to test.
 */

#include "infrastructure/observability/telemetry.h"

#include <opentelemetry/exporters/otlp/otlp_grpc_exporter.h>
#include <opentelemetry/exporters/otlp/otlp_grpc_metric_exporter.h>
#include <opentelemetry/exporters/prometheus/exporter_factory.h>
#include <opentelemetry/sdk/common/global_log_handler.h>
#include <opentelemetry/sdk/metrics/meter_provider.h>
#include <opentelemetry/sdk/metrics/export/periodic_exporting_metric_reader.h>
#include <opentelemetry/sdk/resource/resource.h>
#include <opentelemetry/sdk/trace/batch_span_processor.h>
#include <opentelemetry/sdk/trace/tracer_provider.h>
#include <opentelemetry/trace/provider.h>

#include <spdlog/spdlog.h>

#include <cstdlib>
#include <mutex>
#include <shared_mutex>
#include <unordered_map>

namespace chrono_flow::infra::observability {

// Aliases to avoid typing hell
namespace otel       = opentelemetry;
namespace trace_api  = otel::trace;
namespace metrics_api= otel::metrics;
namespace sdktrace   = otel::sdk::trace;
namespace sdkmetrics = otel::sdk::metrics;

/* ====================================================================== */
/*  Helper utilities                                                      */
/* ====================================================================== */

static otel::sdk::resource::Resource MakeServiceResource(std::string_view service_name,
                                                         std::string_view service_version)
{
    otel::sdk::resource::ResourceAttributes attributes = {
        {"service.name",     std::string{service_name}},
        {"service.version",  std::string{service_version}},
        {"service.instance.id", fmt::format("{}-{}", service_name,
                                            std::to_string(std::rand()))}
    };
    return otel::sdk::resource::Resource::Create(attributes);
}

/* ====================================================================== */
/*  Telemetry::Impl – PIMPL                                               */
/* ====================================================================== */

class Telemetry::Impl
{
public:
    Impl()  = default;
    ~Impl() = default;

    void init(const TelemetryConfig& cfg);
    void shutdown();

    std::shared_ptr<trace_api::Tracer> tracer() const noexcept
    {
        return tracer_;
    }

    std::shared_ptr<metrics_api::Meter> meter() const noexcept
    {
        return meter_;
    }

    std::unique_ptr<SpanGuard> startSpan(std::string_view name,
                                         const SpanAttributes& attrs);

    // Metric helpers – thread-safe
    metrics_api::Counter<uint64_t>    &counter(std::string_view name,
                                               std::string_view description);
    metrics_api::Histogram<double>    &histogram(std::string_view name,
                                                 std::string_view description);
    metrics_api::UpDownCounter<int64_t>& gauge(std::string_view name,
                                               std::string_view description);

private:
    // Keeps previously created metric instruments alive and guarantees we
    // don’t create duplicates.
    template<class InstrumentT>
    InstrumentT &findOrCreate(const std::string &key,
                              std::function<InstrumentT ()> factory);

    // Providers (shared by entire process)
    std::shared_ptr<sdktrace::TracerProvider>   trace_provider_;
    std::shared_ptr<sdkmetrics::MeterProvider>  metric_provider_;

    // Fast access handles (cached)
    std::shared_ptr<trace_api::Tracer>  tracer_;
    std::shared_ptr<metrics_api::Meter> meter_;

    // Instrument caches
    std::unordered_map<std::string,
                       metrics_api::Counter<uint64_t>>      counters_;
    std::unordered_map<std::string,
                       metrics_api::Histogram<double>>      histograms_;
    std::unordered_map<std::string,
                       metrics_api::UpDownCounter<int64_t>> gauges_;

    mutable std::shared_mutex mutex_;
};

/* ---------------------------------------------------------------------- */
/*  Initialization logic                                                  */

void Telemetry::Impl::init(const TelemetryConfig& cfg)
{
    // 1. Tracing
    {
        auto grpc_opts        = opentelemetry::exporter::otlp::OtlpGrpcExporterOptions{};
        grpc_opts.endpoint    = cfg.otlp_traces_endpoint;  // e.g. "otel-collector:4317"
        grpc_opts.timeout     = std::chrono::milliseconds{3000};
        grpc_opts.use_ssl_credentials = cfg.use_ssl;

        auto otlp_exporter  = std::unique_ptr<sdktrace::SpanExporter>{
            new opentelemetry::exporter::otlp::OtlpGrpcExporter(grpc_opts)};

        auto processor      = std::unique_ptr<sdktrace::SpanProcessor>{
            new sdktrace::BatchSpanProcessor(std::move(otlp_exporter))};

        auto resource       = MakeServiceResource(cfg.service_name, cfg.version);

        trace_provider_     = std::make_shared<sdktrace::TracerProvider>(
            std::move(processor),
            resource);

        // Make the provider globally accessible by OpenTelemetry API
        trace_api::Provider::SetTracerProvider(trace_provider_);
        tracer_             = trace_provider_->GetTracer(cfg.service_name);
    }

    // 2. Metrics
    {
        auto resource      = MakeServiceResource(cfg.service_name, cfg.version);

        sdkmetrics::MeterProviderConfig provider_cfg;
        provider_cfg.resource = resource;

        metric_provider_ = std::make_shared<sdkmetrics::MeterProvider>(provider_cfg);
        meter_           = metric_provider_->GetMeter(cfg.service_name);

        // Prometheus exporter is exposed on an HTTP endpoint (default :9464)
        auto prometheus_exporter =
            opentelemetry::exporter::metrics::PrometheusExporterFactory::Create();
        metric_provider_->AddMetricReader(std::move(prometheus_exporter));

        // Optionally, push metrics to OTLP
        if (cfg.enable_otlp_metrics)
        {
            opentelemetry::exporter::otlp::OtlpGrpcMetricExporterOptions mopts;
            mopts.endpoint             = cfg.otlp_metrics_endpoint;
            mopts.use_ssl_credentials  = cfg.use_ssl;

            auto exporter =
              std::unique_ptr<sdkmetrics::MetricExporterInterface>(
                 new opentelemetry::exporter::otlp::OtlpGrpcMetricExporter(mopts));

            auto reader = std::unique_ptr<sdkmetrics::MetricReader>(
                new sdkmetrics::PeriodicExportingMetricReader(
                    std::move(exporter),
                    std::chrono::milliseconds{cfg.metric_export_interval_ms}));

            metric_provider_->AddMetricReader(std::move(reader));
        }

        // Register as global provider
        metrics_api::Provider::SetMeterProvider(metric_provider_);
    }

    spdlog::info("[Telemetry] Initialized (service={}, version={})",
                 cfg.service_name, cfg.version);
}

void Telemetry::Impl::shutdown()
{
    // Flush and shut down – order matters: metrics first, traces last.
    if (metric_provider_)
    {
        metric_provider_->ForceFlush();
        metric_provider_->Shutdown();
    }
    if (trace_provider_)
    {
        trace_provider_->ForceFlush();
        trace_provider_->Shutdown();
    }
    spdlog::info("[Telemetry] Shutdown completed");
}

/* ---------------------------------------------------------------------- */
/*  Span creation                                                         */

std::unique_ptr<SpanGuard> Telemetry::Impl::startSpan(
    std::string_view name,
    const SpanAttributes& attrs)
{
    if (!tracer_)
        return std::unique_ptr<SpanGuard>(new SpanGuard(nullptr));

    auto span = tracer_->StartSpan(std::string{name},
                                   attrs,
                                   {trace_api::SpanKind::kServer});
    return std::unique_ptr<SpanGuard>(new SpanGuard(span));
}

/* ---------------------------------------------------------------------- */
/*  Metric helpers                                                        */

metrics_api::Counter<uint64_t> &
Telemetry::Impl::counter(std::string_view name, std::string_view description)
{
    std::unique_lock lock{mutex_};

    return findOrCreate<metrics_api::Counter<uint64_t>>(
        std::string{name}, [&]() {
            return meter_->CreateUInt64Counter(std::string{name},
                                               std::string{description});
        });
}

metrics_api::Histogram<double> &
Telemetry::Impl::histogram(std::string_view name, std::string_view description)
{
    std::unique_lock lock{mutex_};

    return findOrCreate<metrics_api::Histogram<double>>(
        std::string{name}, [&]() {
            return meter_->CreateDoubleHistogram(std::string{name},
                                                 std::string{description});
        });
}

metrics_api::UpDownCounter<int64_t> &
Telemetry::Impl::gauge(std::string_view name, std::string_view description)
{
    std::unique_lock lock{mutex_};

    return findOrCreate<metrics_api::UpDownCounter<int64_t>>(
        std::string{name}, [&]() {
            return meter_->CreateInt64UpDownCounter(std::string{name},
                                                    std::string{description});
        });
}

template<class InstrumentT>
InstrumentT &
Telemetry::Impl::findOrCreate(const std::string &key,
                              std::function<InstrumentT ()> factory)
{
    if constexpr (std::is_same_v<InstrumentT, metrics_api::Counter<uint64_t>>)
    {
        auto it = counters_.find(key);
        if (it == counters_.end())
        {
            auto [pos, _] = counters_.emplace(key, factory());
            return pos->second;
        }
        return it->second;
    }
    else if constexpr (std::is_same_v<InstrumentT, metrics_api::Histogram<double>>)
    {
        auto it = histograms_.find(key);
        if (it == histograms_.end())
        {
            auto [pos, _] = histograms_.emplace(key, factory());
            return pos->second;
        }
        return it->second;
    }
    else // gauges
    {
        auto it = gauges_.find(key);
        if (it == gauges_.end())
        {
            auto [pos, _] = gauges_.emplace(key, factory());
            return pos->second;
        }
        return it->second;
    }
}

/* ====================================================================== */
/*  Public Telemetry singleton facade                                     */
/* ====================================================================== */

Telemetry& Telemetry::instance()
{
    static Telemetry singleton;
    return singleton;
}

Telemetry::Telemetry()
    : impl_{std::make_unique<Impl>()}
{
}

Telemetry::~Telemetry()
{
    // Ensure graceful shutdown at program exit
    impl_->shutdown();
}

/* ---------------------------------------------------------------------- */

void Telemetry::init(const TelemetryConfig& cfg)
{
    impl_->init(cfg);
}

std::unique_ptr<SpanGuard> Telemetry::startSpan(std::string_view name,
                                                const SpanAttributes& attrs)
{
    return impl_->startSpan(name, attrs);
}

metrics_api::Counter<uint64_t> &
Telemetry::counter(std::string_view name, std::string_view desc)
{
    return impl_->counter(name, desc);
}

metrics_api::Histogram<double> &
Telemetry::histogram(std::string_view name, std::string_view desc)
{
    return impl_->histogram(name, desc);
}

metrics_api::UpDownCounter<int64_t> &
Telemetry::gauge(std::string_view name, std::string_view desc)
{
    return impl_->gauge(name, desc);
}

void Telemetry::shutdown()
{
    impl_->shutdown();
}

/* ====================================================================== */
/*  SpanGuard RAII helper (header-only, but implement destructor here)    */
/* ====================================================================== */

SpanGuard::~SpanGuard()
{
    if (span_)
    {
        span_->End();
    }
}

/* ====================================================================== */
/*  Macro helpers implementation                                          */
/* ====================================================================== */

void recordRestLatency(double milliseconds)
{
    static auto &hist = Telemetry::instance().histogram(
        "rest.request.latency",
        "Latency of REST requests (ms)");
    hist.Record(milliseconds);
}

void incrementRestRequestCount()
{
    static auto &ctr = Telemetry::instance().counter(
        "rest.request.total",
        "Total number of REST requests");
    ctr.Add(1);
}

} // namespace chrono_flow::infra::observability
```