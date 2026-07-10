#include "core/services/commands/CreateAssetCommandHandler.hpp"

#include <chrono>
#include <future>
#include <optional>
#include <stdexcept>
#include <utility>

#include <spdlog/spdlog.h>
#include <nlohmann/json.hpp>

using namespace std::chrono_literals;

namespace paletteflux::core::services::commands
{

// ---------------------------------------------------------------------------------------------------------------------
// Helper: scoped timer for metrics
// ---------------------------------------------------------------------------------------------------------------------
class ScopedMetricTimer final
{
public:
    ScopedMetricTimer(std::shared_ptr<telemetry::IMetricCollector> collector,
                      std::string_view                                 metricName)
        : collector_(std::move(collector))
        , metricName_(metricName)
        , start_(std::chrono::steady_clock::now())
    {
    }

    ~ScopedMetricTimer()
    {
        if (auto collector = collector_.lock())
        {
            const auto end     = std::chrono::steady_clock::now();
            const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(end - start_).count();
            collector->recordHistogram(metricName_, static_cast<double>(elapsed));
        }
    }

private:
    std::weak_ptr<telemetry::IMetricCollector> collector_;
    std::string                                metricName_;
    std::chrono::steady_clock::time_point      start_;
};

// ---------------------------------------------------------------------------------------------------------------------
// Ctor
// ---------------------------------------------------------------------------------------------------------------------
CreateAssetCommandHandler::CreateAssetCommandHandler(
    std::shared_ptr<domain::repositories::IAssetRepository>      repository,
    std::shared_ptr<domain::events::IDomainEventDispatcher>      eventDispatcher,
    std::shared_ptr<telemetry::IMetricCollector>                 metricsCollector,
    std::shared_ptr<security::IAuthorizationService>             authorizationService)
    : repository_(std::move(repository))
    , eventDispatcher_(std::move(eventDispatcher))
    , metricsCollector_(std::move(metricsCollector))
    , authorizationService_(std::move(authorizationService))
{
    if (!repository_ || !eventDispatcher_ || !metricsCollector_ || !authorizationService_)
    {
        throw std::invalid_argument(
            "CreateAssetCommandHandler – one or more mandatory dependencies are null.");
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------------------------------------------------
domain::model::AssetId CreateAssetCommandHandler::handle(const CreateAssetCommand& command)
{
    ScopedMetricTimer timer(metricsCollector_, "command.create_asset.duration_ms");

    spdlog::trace("CreateAssetCommandHandler::handle – correlationId={}, user={}, payloadSz={}",
                  command.correlationId(), command.initiatorId(),
                  command.payload().dump().size());

    // --------------------------------------------------
    // 1) Security: verify caller is allowed to create assets of this type
    // --------------------------------------------------
    if (!authorizationService_->isAuthorized(command.initiatorId(), "asset:create"))
    {
        metricsCollector_->incrementCounter("command.create_asset.denied");
        throw security::AuthorizationException("User is not allowed to create assets");
    }

    // --------------------------------------------------
    // 2) Validation
    // --------------------------------------------------
    validate(command);

    // --------------------------------------------------
    // 3) Map incoming DTO → Domain model
    // --------------------------------------------------
    domain::model::Asset domainAsset = domain::factories::AssetFactory::fromJson(
        command.payload(), command.initiatorId());

    // --------------------------------------------------
    // 4) Persist asynchronously (might involve uploading binary blobs)
    // --------------------------------------------------
    const auto persistTask = std::async(std::launch::async,
                                        [repo = repository_, asset = std::move(domainAsset)]() mutable {
                                            // Using optimistic concurrency; repository may throw if conflicting slug
                                            return repo->insert(std::move(asset));
                                        });

    // --------------------------------------------------
    // 5) Wait for completion (with a deadline)
    // --------------------------------------------------
    if (persistTask.wait_for(kRepositoryTimeout) != std::future_status::ready)
    {
        metricsCollector_->incrementCounter("command.create_asset.timeout");
        throw util::TimeoutException("Timed out while persisting new asset");
    }

    const domain::model::AssetId newAssetId = persistTask.get();

    // --------------------------------------------------
    // 6) Emit domain event
    // --------------------------------------------------
    domain::events::AssetCreatedEvent evt{newAssetId,
                                          command.initiatorId(),
                                          command.correlationId(),
                                          command.requestedAt()};
    eventDispatcher_->dispatch(evt);

    metricsCollector_->incrementCounter("command.create_asset.success");

    spdlog::info("Asset created – id={}, user={}, correlationId={}", newAssetId.value(),
                 command.initiatorId(), command.correlationId());

    return newAssetId;
}

// ---------------------------------------------------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------------------------------------------------
void CreateAssetCommandHandler::validate(const CreateAssetCommand& cmd) const
{
    // Generic validation
    if (cmd.payload().is_null() || cmd.payload().empty())
    {
        throw std::invalid_argument("CreateAssetCommand – payload must not be empty");
    }

    // Business rule: each asset must have a non-empty name shorter than 128 chars
    const auto& payload = cmd.payload();
    if (!payload.contains("name") || payload["name"].get<std::string>().empty())
    {
        throw domain::exceptions::ValidationException("Asset name must be provided");
    }
    if (payload["name"].get<std::string>().length() > 127)
    {
        throw domain::exceptions::ValidationException("Asset name is too long");
    }

    // Potentially heavy semantic validation—offloaded to separate component
    auto validationResult = repository_->validateSemanticRules(payload);
    if (!validationResult.ok())
    {
        throw domain::exceptions::ValidationException(validationResult.message());
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------------------------------------------------
constexpr std::chrono::milliseconds CreateAssetCommandHandler::kRepositoryTimeout;

} // namespace paletteflux::core::services::commands