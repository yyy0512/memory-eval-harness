#ifndef PALETTEFLUX_STUDIO_CORE_SERVICES_COMMANDS_CREATEASSETCOMMAND_H
#define PALETTEFLUX_STUDIO_CORE_SERVICES_COMMANDS_CREATEASSETCOMMAND_H

/**
 *  PaletteFlux GraphQL Studio
 *  Copyright (c) 2024
 *
 *  Header      : CreateAssetCommand.h
 *  Description : Command object representing the intention to create a new creative
 *                asset within the PaletteFlux Studio domain.  Designed to be passed
 *                through the Command-Bus infrastructure and handled by a dedicated
 *                CreateAssetCommandHandler.
 *
 *  The command is immutable once constructed; validation is performed eagerly,
 *  throwing std::invalid_argument for pre-execution failures.
 */

#include <chrono>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

#include <nlohmann/json.hpp>   // MIT-licensed single-header JSON library

namespace paletteflux::core::services::commands {

/**
 * Represents the type of asset a user wishes to create.
 * Keep alphabetically-sorted to avoid merge conflicts.
 */
enum class AssetKind : std::uint8_t
{
    AnimationCurve,
    BrushStroke,
    ShaderNode,
    SoundLayer,
    Unknown
};

/**
 * Helper to convert a user-facing string to an AssetKind enum.
 * Throws std::invalid_argument when the input is not recognized.
 */
inline AssetKind assetKindFromString(std::string_view name)
{
    if (name == "AnimationCurve") return AssetKind::AnimationCurve;
    if (name == "BrushStroke")    return AssetKind::BrushStroke;
    if (name == "ShaderNode")     return AssetKind::ShaderNode;
    if (name == "SoundLayer")     return AssetKind::SoundLayer;

    throw std::invalid_argument("CreateAssetCommand::assetKindFromString: unrecognized asset kind '" +
                                std::string{name} + "'");
}

/**
 * Lightweight UUID generator.  Substitute with a proper UUID library where available.
 * This implementation is sufficient for command correlation in a single-process context.
 */
inline std::string pseudoUuid()
{
    static thread_local std::mt19937_64 rng{
        static_cast<std::uint64_t>(std::chrono::high_resolution_clock::now()
                                       .time_since_epoch()
                                       .count())};

    auto rand64 = [] { return rng(); };

    char buffer[32];
    std::snprintf(buffer,
                  sizeof(buffer),
                  "%08llx%08llx%08llx%08llx",
                  static_cast<unsigned long long>(rand64()),
                  static_cast<unsigned long long>(rand64()),
                  static_cast<unsigned long long>(rand64()),
                  static_cast<unsigned long long>(rand64()));
    return {buffer, 32};
}

/**
 * Immutable command DTO for asset creation.
 */
class CreateAssetCommand
{
public:
    using Json = nlohmann::json;
    using Clock = std::chrono::system_clock;
    using TimePoint = std::chrono::time_point<Clock>;

    /**
     * Factory method. Performs argument validation and returns an immutable command.
     *
     * @param tenantId  Multi-tenant identifier of the workspace performing the mutation.
     * @param authorId  ID of the user initiating the request.
     * @param name      Human-readable asset name; must be non-empty.
     * @param kind      Asset kind enumeration; must not be AssetKind::Unknown.
     * @param payload   JSON blob containing the canonical asset specification.
     * @param requestId Correlation id for the originating HTTP / GraphQL request.
     */
    static CreateAssetCommand make(std::string tenantId,
                                   std::string authorId,
                                   std::string name,
                                   AssetKind kind,
                                   Json payload,
                                   std::optional<std::string> requestId = std::nullopt)
    {
        // Basic validation
        if (tenantId.empty())
            throw std::invalid_argument("CreateAssetCommand: tenantId must not be empty");

        if (authorId.empty())
            throw std::invalid_argument("CreateAssetCommand: authorId must not be empty");

        if (name.empty())
            throw std::invalid_argument("CreateAssetCommand: name must not be empty");

        if (kind == AssetKind::Unknown)
            throw std::invalid_argument("CreateAssetCommand: kind must be a concrete AssetKind");

        if (payload.is_discarded())
            throw std::invalid_argument("CreateAssetCommand: payload is invalid JSON");

        return CreateAssetCommand(std::move(tenantId),
                                  std::move(authorId),
                                  std::move(name),
                                  kind,
                                  std::move(payload),
                                  std::move(requestId));
    }

    // Copy / move semantics are defaulted—the class is trivially copyable.
    CreateAssetCommand(const CreateAssetCommand&) = default;
    CreateAssetCommand(CreateAssetCommand&&) = default;
    CreateAssetCommand& operator=(const CreateAssetCommand&) = default;
    CreateAssetCommand& operator=(CreateAssetCommand&&) = default;

    // Accessors
    [[nodiscard]] const std::string& id()        const noexcept { return m_id; }
    [[nodiscard]] const std::string& tenantId()  const noexcept { return m_tenantId; }
    [[nodiscard]] const std::string& authorId()  const noexcept { return m_authorId; }
    [[nodiscard]] const std::string& name()      const noexcept { return m_name; }
    [[nodiscard]] AssetKind            kind()    const noexcept { return m_kind; }
    [[nodiscard]] const Json&          payload() const noexcept { return m_payload; }
    [[nodiscard]] const std::optional<std::string>& requestId() const noexcept { return m_requestId; }
    [[nodiscard]] TimePoint            issuedAt() const noexcept { return m_issuedAt; }

private:
    // Private to force use of factory method.
    CreateAssetCommand(std::string tenantId,
                       std::string authorId,
                       std::string name,
                       AssetKind kind,
                       Json payload,
                       std::optional<std::string> requestId)
        : m_id(pseudoUuid())
        , m_tenantId(std::move(tenantId))
        , m_authorId(std::move(authorId))
        , m_name(std::move(name))
        , m_kind(kind)
        , m_payload(std::move(payload))
        , m_requestId(std::move(requestId))
        , m_issuedAt(Clock::now())
    {
        // All validation has already been performed by the factory.
    }

    // Members in declaration order for concise initialization above.
    std::string             m_id;        // Command id (UUID).
    std::string             m_tenantId;  // Multi-tenant isolation.
    std::string             m_authorId;  // User performing the operation.
    std::string             m_name;      // Display name for the new asset.
    AssetKind               m_kind;      // Enum describing the asset type.
    Json                    m_payload;   // DSL representation of the asset.
    std::optional<std::string> m_requestId; // Correlates with external request scopes.
    TimePoint               m_issuedAt;  // When the command was created (UTC).
};

} // namespace paletteflux::core::services::commands

#endif // PALETTEFLUX_STUDIO_CORE_SERVICES_COMMANDS_CREATEASSETCOMMAND_H
