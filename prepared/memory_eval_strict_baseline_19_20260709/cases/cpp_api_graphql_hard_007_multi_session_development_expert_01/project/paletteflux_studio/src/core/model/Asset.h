#pragma once
/**
 * PaletteFlux GraphQL Studio
 * File: paletteflux_studio/src/core/model/Asset.h
 *
 * Copyright (c) PaletteFlux
 *
 * Description:
 *   Domain model representing a creative asset (brush stroke, shader node,
 *   animation curve, sound layer, etc.). An Asset is an immutable*,
 *   globally–addressable entity identified by a UUID and enriched with
 *   metadata critical for versioning, auditing, pagination and caching.
 *
 *   (*) Mutations happen by creating a new version and marking the previous
 *   version as superseded. The model therefore exposes "with*" builders that
 *   return copies rather than in-place mutations—allowing easy composition
 *   of Command side workflows while keeping the Query side cache-friendly.
 *
 *   The header is intentionally self-contained so it can be safely included
 *   by multiple micro-services without dragging unnecessary runtime deps.
 */

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <ostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include <boost/uuid/uuid.hpp>
#include <boost/uuid/uuid_generators.hpp>
#include <boost/uuid/uuid_io.hpp>

#include <nlohmann/json.hpp>

namespace paletteflux::core::model {

//----------------------------------------------------------------------------
// AssetType
//----------------------------------------------------------------------------
enum class AssetType : std::uint8_t
{
    Unknown         = 0,
    BrushStroke     = 1,
    ShaderNode      = 2,
    AnimationCurve  = 3,
    SoundLayer      = 4
};

std::string_view to_string(AssetType type);
AssetType        asset_type_from_string(std::string_view str);

//----------------------------------------------------------------------------
// AssetId  – thin wrapper around boost::uuids::uuid
//----------------------------------------------------------------------------
class AssetId
{
public:
    /// Generates a new random UUID.
    static AssetId random();

    /// Parses from canonical string form (throws std::invalid_argument on fail)
    static AssetId from_string(std::string_view s);

    AssetId() = default;
    explicit AssetId(boost::uuids::uuid uuid) noexcept : _uuid{std::move(uuid)} {}

    [[nodiscard]] const boost::uuids::uuid& uuid() const noexcept { return _uuid; }
    [[nodiscard]] std::string to_string() const;

    friend bool operator==(const AssetId& a, const AssetId& b) noexcept
    {
        return a._uuid == b._uuid;
    }
    friend bool operator!=(const AssetId& a, const AssetId& b) noexcept
    {
        return !(a == b);
    }
    friend std::ostream& operator<<(std::ostream& os, const AssetId& id)
    {
        return os << id.to_string();
    }

private:
    boost::uuids::uuid _uuid{};
};

} // namespace paletteflux::core::model

namespace std {
template <>
struct hash<paletteflux::core::model::AssetId>
{
    std::size_t operator()(const paletteflux::core::model::AssetId& id) const noexcept
    {
        const auto* data = id.uuid().data;
        static_assert(sizeof(boost::uuids::uuid) == 16);
        std::size_t h{};
        std::memcpy(&h, data, sizeof(std::size_t));
        return h;
    }
};
} // namespace std

namespace paletteflux::core::model {

//----------------------------------------------------------------------------
// AssetValidationError – thrown by Asset::validate()
//----------------------------------------------------------------------------
struct AssetValidationError : public std::runtime_error
{
    explicit AssetValidationError(std::string msg) : std::runtime_error{std::move(msg)} {}
};

//----------------------------------------------------------------------------
// Asset
//----------------------------------------------------------------------------
class Asset
{
public:
    using time_point = std::chrono::system_clock::time_point;
    using MetaMap    = std::unordered_map<std::string, std::string>;

    //------------------------------------------------------------------------
    // Construction
    //------------------------------------------------------------------------
    static Asset createNew(
        AssetType         type,
        std::string       name,
        std::string       ownerUserId,
        MetaMap           metadata = {},
        std::vector<std::string> tags = {});

    Asset() = default;

    Asset(AssetId            id,
          AssetType          type,
          std::string        name,
          std::string        ownerUserId,
          std::string        description,
          std::uint32_t      version,
          time_point         createdAt,
          time_point         updatedAt,
          std::vector<std::string> tags,
          MetaMap            metadata);

    //------------------------------------------------------------------------
    // Read-only accessors
    //------------------------------------------------------------------------
    [[nodiscard]] const AssetId&               id()          const noexcept { return _id; }
    [[nodiscard]] AssetType                    type()        const noexcept { return _type; }
    [[nodiscard]] const std::string&           name()        const noexcept { return _name; }
    [[nodiscard]] const std::string&           ownerUserId() const noexcept { return _ownerUserId; }
    [[nodiscard]] const std::string&           description() const noexcept { return _description; }
    [[nodiscard]] std::uint32_t                version()     const noexcept { return _version; }
    [[nodiscard]] time_point                   createdAt()   const noexcept { return _createdAt; }
    [[nodiscard]] time_point                   updatedAt()   const noexcept { return _updatedAt; }
    [[nodiscard]] const std::vector<std::string>& tags()     const noexcept { return _tags; }
    [[nodiscard]] const MetaMap&               metadata()   const noexcept { return _metadata; }

    //------------------------------------------------------------------------
    // Builder-style "with" operations
    //------------------------------------------------------------------------
    Asset withName(std::string newName) const;
    Asset withDescription(std::string newDescription) const;
    Asset withMetadata(MetaMap newMetadata) const;
    Asset withTags(std::vector<std::string> newTags) const;
    Asset bumpVersion() const;

    //------------------------------------------------------------------------
    // Domain helpers
    //------------------------------------------------------------------------
    [[nodiscard]] bool   isPublic() const;   // convenience: metadata flag
    [[nodiscard]] size_t approximateByteSize() const; // used by caching layer

    //------------------------------------------------------------------------
    // Validation
    //------------------------------------------------------------------------
    void validate() const; // throws AssetValidationError

    //------------------------------------------------------------------------
    // (De)Serialisation helpers
    //------------------------------------------------------------------------
    [[nodiscard]] nlohmann::json toJson() const;
    static Asset fromJson(const nlohmann::json& j); // throws on errors

    //------------------------------------------------------------------------
    // Equality compares all fields (except timestamps may be approximated)
    //------------------------------------------------------------------------
    friend bool operator==(const Asset& a, const Asset& b) noexcept;
    friend bool operator!=(const Asset& a, const Asset& b) noexcept
    {
        return !(a == b);
    }

private:
    AssetId               _id;
    AssetType             _type {AssetType::Unknown};
    std::string           _name;
    std::string           _ownerUserId;
    std::string           _description;
    std::uint32_t         _version {1};
    time_point            _createdAt{};
    time_point            _updatedAt{};
    std::vector<std::string> _tags;
    MetaMap               _metadata;
};

//----------------------------------------------------------------------------
// Inline / Header-only implementation
//----------------------------------------------------------------------------

inline std::string_view to_string(AssetType type)
{
    switch (type)
    {
        using enum AssetType;
        case BrushStroke:    return "BRUSH_STROKE";
        case ShaderNode:     return "SHADER_NODE";
        case AnimationCurve: return "ANIMATION_CURVE";
        case SoundLayer:     return "SOUND_LAYER";
        default:             return "UNKNOWN";
    }
}

inline AssetType asset_type_from_string(std::string_view str)
{
    if (str == "BRUSH_STROKE")    return AssetType::BrushStroke;
    if (str == "SHADER_NODE")     return AssetType::ShaderNode;
    if (str == "ANIMATION_CURVE") return AssetType::AnimationCurve;
    if (str == "SOUND_LAYER")     return AssetType::SoundLayer;
    return AssetType::Unknown;
}

// -- AssetId -----------------------------------------------------------------
inline AssetId AssetId::random()
{
    static thread_local boost::uuids::random_generator gen;
    return AssetId{gen()};
}

inline AssetId AssetId::from_string(std::string_view s)
{
    boost::uuids::string_generator gen;
    try
    {
        return AssetId{gen(std::string{s})};
    }
    catch (const std::exception&)
    {
        throw std::invalid_argument{"AssetId::from_string – invalid UUID string"};
    }
}

inline std::string AssetId::to_string() const
{
    return boost::uuids::to_string(_uuid);
}

// -- Asset Constructors ------------------------------------------------------
inline Asset Asset::createNew(
    AssetType type,
    std::string name,
    std::string ownerUserId,
    MetaMap metadata,
    std::vector<std::string> tags)
{
    const auto now = std::chrono::system_clock::now();
    Asset asset{
        AssetId::random(),
        type,
        std::move(name),
        std::move(ownerUserId),
        {},
        1,
        now,
        now,
        std::move(tags),
        std::move(metadata)};
    asset.validate();
    return asset;
}

inline Asset::Asset(AssetId id,
                    AssetType type,
                    std::string name,
                    std::string ownerUserId,
                    std::string description,
                    std::uint32_t version,
                    time_point createdAt,
                    time_point updatedAt,
                    std::vector<std::string> tags,
                    MetaMap metadata)
    : _id{std::move(id)},
      _type{type},
      _name{std::move(name)},
      _ownerUserId{std::move(ownerUserId)},
      _description{std::move(description)},
      _version{version},
      _createdAt{createdAt},
      _updatedAt{updatedAt},
      _tags{std::move(tags)},
      _metadata{std::move(metadata)}
{
}

// -- Builder helpers ---------------------------------------------------------
inline Asset Asset::withName(std::string newName) const
{
    Asset copy{*this};
    copy._name       = std::move(newName);
    copy._updatedAt  = std::chrono::system_clock::now();
    copy.validate();
    return copy;
}

inline Asset Asset::withDescription(std::string newDescription) const
{
    Asset copy{*this};
    copy._description = std::move(newDescription);
    copy._updatedAt   = std::chrono::system_clock::now();
    return copy;
}

inline Asset Asset::withMetadata(MetaMap newMetadata) const
{
    Asset copy{*this};
    copy._metadata  = std::move(newMetadata);
    copy._updatedAt = std::chrono::system_clock::now();
    return copy;
}

inline Asset Asset::withTags(std::vector<std::string> newTags) const
{
    Asset copy{*this};
    copy._tags      = std::move(newTags);
    copy._updatedAt = std::chrono::system_clock::now();
    return copy;
}

inline Asset Asset::bumpVersion() const
{
    Asset copy{*this};
    ++copy._version;
    copy._updatedAt = std::chrono::system_clock::now();
    return copy;
}

// -- Domain helpers ----------------------------------------------------------
inline bool Asset::isPublic() const
{
    auto it = _metadata.find("visibility");
    return it != _metadata.end() && it->second == "public";
}

inline size_t Asset::approximateByteSize() const
{
    size_t size = sizeof(Asset);
    size += _name.size() + _ownerUserId.size() + _description.size();
    for (const auto& tag : _tags) size += tag.size();
    for (const auto& [k, v] : _metadata) size += k.size() + v.size();
    return size;
}

// -- Validation --------------------------------------------------------------
inline void Asset::validate() const
{
    if (_name.empty())
        throw AssetValidationError{"Asset validation failed: name must not be empty."};
    if (_ownerUserId.empty())
        throw AssetValidationError{"Asset validation failed: ownerUserId must not be empty."};
    if (_type == AssetType::Unknown)
        throw AssetValidationError{"Asset validation failed: type must be specified."};
}

// -- Serialisation -----------------------------------------------------------
inline nlohmann::json Asset::toJson() const
{
    using nlohmann::json;
    json j;
    j["id"]          = _id.to_string();
    j["type"]        = std::string{to_string(_type)};
    j["name"]        = _name;
    j["ownerUserId"] = _ownerUserId;
    j["description"] = _description;
    j["version"]     = _version;
    j["createdAt"]   = std::chrono::duration_cast<std::chrono::milliseconds>(
                           _createdAt.time_since_epoch()).count();
    j["updatedAt"]   = std::chrono::duration_cast<std::chrono::milliseconds>(
                           _updatedAt.time_since_epoch()).count();
    j["tags"]        = _tags;
    j["metadata"]    = _metadata;
    return j;
}

inline Asset Asset::fromJson(const nlohmann::json& j)
{
    using nlohmann::json;

    auto id         = AssetId::from_string(j.at("id").get<std::string>());
    auto type       = asset_type_from_string(j.at("type").get<std::string>());
    auto name       = j.at("name").get<std::string>();
    auto owner      = j.at("ownerUserId").get<std::string>();
    auto description= j.value("description", "");
    auto version    = j.value("version", 1U);

    auto epoch_ms_to_tp = [](std::int64_t ms) {
        return Asset::time_point{std::chrono::milliseconds{ms}};
    };

    auto createdAt  = epoch_ms_to_tp(j.at("createdAt").get<std::int64_t>());
    auto updatedAt  = epoch_ms_to_tp(j.at("updatedAt").get<std::int64_t>());

    std::vector<std::string> tags  = j.value("tags", std::vector<std::string>{});
    MetaMap metadata               = j.value("metadata", MetaMap{});

    Asset asset{
        id,
        type,
        std::move(name),
        std::move(owner),
        std::move(description),
        version,
        createdAt,
        updatedAt,
        std::move(tags),
        std::move(metadata)};

    asset.validate();
    return asset;
}

// -- Equality ----------------------------------------------------------------
inline bool operator==(const Asset& a, const Asset& b) noexcept
{
    return a.id()          == b.id()          &&
           a.type()        == b.type()        &&
           a.name()        == b.name()        &&
           a.ownerUserId() == b.ownerUserId() &&
           a.description() == b.description() &&
           a.version()     == b.version()     &&
           a.tags()        == b.tags()        &&
           a.metadata()    == b.metadata();
}

} // namespace paletteflux::core::model