#ifndef PALETTEFLUX_STUDIO_CORE_MODEL_SHADERNODE_H_
#define PALETTEFLUX_STUDIO_CORE_MODEL_SHADERNODE_H_

/**
 *  PaletteFlux GraphQL Studio
 *  File: ShaderNode.h
 *
 *  Description:
 *      Declares the ShaderNode abstraction used by the PaletteFlux rendering
 *      pipeline.  A ShaderNode represents a single node in a GPU-side shader
 *      graph.  Nodes may be connected to each other, configured with typed
 *      parameters, and serialized to multiple representations (e.g. GLSL,
 *      JSON, or GraphQL DTOs).
 *
 *  The class is designed for concurrent use by query / command handlers:
 *      – Mutations acquire an exclusive lock.
 *      – Reads acquire a shared lock, allowing highly-parallel queries.
 *
 *  Copyright (c) PaletteFlux
 */

#include <array>
#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <shared_mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <variant>
#include <vector>

namespace paletteflux::core::model
{

/* ──────────────────────────────────────────────────────────────────────────── */
/*  Small utility math primitives (header-only to avoid heavy external deps)   */
/* ──────────────────────────────────────────────────────────────────────────── */
struct Vec2
{
    float x{0.f}, y{0.f};

    constexpr bool operator==(const Vec2 &o) const noexcept
    {
        return x == o.x && y == o.y;
    }
};
struct Vec3
{
    float x{0.f}, y{0.f}, z{0.f};

    constexpr bool operator==(const Vec3 &o) const noexcept
    {
        return x == o.x && y == o.y && z == o.z;
    }
};
struct Vec4
{
    float x{0.f}, y{0.f}, z{0.f}, w{0.f};

    constexpr bool operator==(const Vec4 &o) const noexcept
    {
        return x == o.x && y == o.y && z == o.z && w == o.w;
    }
};

/* ──────────────────────────────────────────────────────────────────────────── */
/*  ShaderNode Declaration                                                     */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 *  ShaderStage enumerates pipeline stages supported by PaletteFlux.
 */
enum class ShaderStage : std::uint8_t
{
    Vertex,
    Fragment,
    Geometry,
    Compute
};

/**
 * ShaderNode
 *
 * Abstract base class representing a node in a shader graph.  Instances are
 * reference-counted through std::shared_ptr so they can be safely passed
 * across asynchronous command / query boundaries.
 *
 * Concurrency:
 *   – Internal state is guarded by a mutable std::shared_mutex.
 *   – All mutator methods lock exclusively; accessors lock shared mode.
 */
class ShaderNode : public std::enable_shared_from_this<ShaderNode>
{
public:
    /*  Public typedefs */
    using NodeId          = std::string;
    using ConnectionLabel = std::string;

    /*  Parameter values are stored using std::variant for type safety. */
    using ParameterValue = std::variant<
        int,
        float,
        Vec2,
        Vec3,
        Vec4,
        std::string>;

    struct ParameterMeta
    {
        std::string  displayName;
        std::string  doc;
        ParameterValue defaultValue;
    };

    /*  Convenience pointer alias. */
    using Ptr = std::shared_ptr<ShaderNode>;

    /*  Destructor */
    virtual ~ShaderNode() = default;

    /* ─────────────── Identity ─────────────── */
    const NodeId & id() const noexcept { return m_id; }

    /* ─────────────── Stage Information ────── */
    ShaderStage stage() const noexcept { return m_stage; }

    /* ─────────────── Parameter API ────────── */
    void setParameter(const std::string &key, ParameterValue value);
    [[nodiscard]] std::optional<ParameterValue> getParameter(const std::string &key) const;
    [[nodiscard]] std::unordered_map<std::string, ParameterValue> parameters() const;

    /* ─────────────── Connection API ───────── */
    void connect(const ConnectionLabel &inputLabel, const Ptr &sourceNode);
    void disconnect(const ConnectionLabel &inputLabel);

    [[nodiscard]] std::optional<Ptr> connectedNode(const ConnectionLabel &inputLabel) const;
    [[nodiscard]] std::unordered_map<ConnectionLabel, Ptr> connections() const;

    /* ─────────────── Serialization ────────── */
    /**
     * Serializes the node and its parameters to a GLSL code snippet.
     * Thread-safe; employs internal caching to avoid recomputation.
     */
    [[nodiscard]] std::string toGLSL() const;

    /**
     * Serialize the node to JSON representation (stringified).
     * The actual JSON serializer is intentionally lightweight to avoid
     * hard dependency on a specific JSON lib in the public header.
     */
    [[nodiscard]] std::string toJSON() const;

    /* ─────────────── Runtime Introspection ── */
    /**
     * Enumerates transitive closure of the node’s upstream dependencies.
     * dfsVisitor will be called with each visited node exactly once in
     * topological order.
     */
    void depthFirstTraverse(const std::function<void(const Ptr&)> &dfsVisitor) const;

protected:
    /*  Constructible only by derived classes. */
    ShaderNode(NodeId id, ShaderStage stage);

    /*  Derived classes must provide GLSL body for their specific operation. */
    virtual std::string buildGLSLBody() const = 0;

    /*  Derived classes may override to expose custom parameter meta. */
    [[nodiscard]] virtual std::unordered_map<std::string, ParameterMeta> parameterMeta() const;

private:
    /*  Non-copyable / non-movable */
    ShaderNode(const ShaderNode&) = delete;
    ShaderNode& operator=(const ShaderNode&) = delete;

    /*  Caching helper */
    [[nodiscard]] std::string computeGLSL() const;

    /*  Internal state guarded by mutex */
    NodeId                                              m_id;
    ShaderStage                                         m_stage;
    std::unordered_map<std::string, ParameterValue>     m_parameters;
    std::unordered_map<ConnectionLabel, Ptr>            m_inputs;

    mutable std::shared_mutex                           m_mutex;

    /*  Cached GLSL (mutable to allow lazy computation in const method). */
    mutable std::optional<std::string>                  m_cachedGLSL;
};

/* ──────────────────────────────────────────────────────────────────────────── */
/*  Inline Implementations                                                     */
/* ──────────────────────────────────────────────────────────────────────────── */

inline ShaderNode::ShaderNode(NodeId id, ShaderStage stage)
    : m_id(std::move(id))
    , m_stage(stage)
{}

inline void ShaderNode::setParameter(const std::string &key, ParameterValue value)
{
    std::unique_lock lock(m_mutex);
    m_parameters[key] = std::move(value);
    m_cachedGLSL.reset(); // invalidate cache
}

inline std::optional<ShaderNode::ParameterValue>
ShaderNode::getParameter(const std::string &key) const
{
    std::shared_lock lock(m_mutex);
    auto it = m_parameters.find(key);
    if (it == m_parameters.end())
        return std::nullopt;
    return it->second;
}

inline std::unordered_map<std::string, ShaderNode::ParameterValue>
ShaderNode::parameters() const
{
    std::shared_lock lock(m_mutex);
    return m_parameters;
}

inline void ShaderNode::connect(const ConnectionLabel &inputLabel, const Ptr &sourceNode)
{
    if (!sourceNode)
        throw std::invalid_argument("ShaderNode::connect: sourceNode must not be null");

    std::unique_lock lock(m_mutex);
    m_inputs[inputLabel] = sourceNode;
    m_cachedGLSL.reset(); // invalidate cache
}

inline void ShaderNode::disconnect(const ConnectionLabel &inputLabel)
{
    std::unique_lock lock(m_mutex);
    m_inputs.erase(inputLabel);
    m_cachedGLSL.reset(); // invalidate cache
}

inline std::optional<ShaderNode::Ptr>
ShaderNode::connectedNode(const ConnectionLabel &inputLabel) const
{
    std::shared_lock lock(m_mutex);
    auto it = m_inputs.find(inputLabel);
    if (it == m_inputs.end())
        return std::nullopt;
    return it->second;
}

inline std::unordered_map<ShaderNode::ConnectionLabel, ShaderNode::Ptr>
ShaderNode::connections() const
{
    std::shared_lock lock(m_mutex);
    return m_inputs;
}

inline std::string ShaderNode::computeGLSL() const
{
    /* Build GLSL by concatenating dependencies first */
    std::ostringstream ss;
    for (const auto &[label, node] : m_inputs)
    {
        (void)label; // label is ignored in this simplistic example
        ss << node->toGLSL() << '\n';
    }
    ss << buildGLSLBody();
    return ss.str();
}

inline std::string ShaderNode::toGLSL() const
{
    std::shared_lock readLock(m_mutex);
    if (m_cachedGLSL.has_value())
        return *m_cachedGLSL;

    /* Need to upgrade lock to compute. */
    readLock.unlock();
    std::unique_lock writeLock(m_mutex);
    if (!m_cachedGLSL.has_value()) // re-check after upgrading
        m_cachedGLSL = computeGLSL();

    return *m_cachedGLSL;
}

inline std::string ShaderNode::toJSON() const
{
    std::shared_lock lock(m_mutex);

    std::ostringstream ss;
    ss << "{\n";
    ss << "  \"id\": \"" << m_id << "\",\n";
    ss << "  \"stage\": " << static_cast<int>(m_stage) << ",\n";
    ss << "  \"parameters\": {\n";
    bool first = true;
    for (const auto &[k, v] : m_parameters)
    {
        if (!first) ss << ",\n";
        first = false;
        ss << "    \"" << k << "\": \"";
        std::visit([&ss](auto &&arg) { ss << arg; }, v);
        ss << "\"";
    }
    ss << "\n  },\n";
    ss << "  \"connections\": [";
    first = true;
    for (const auto &[lbl, n] : m_inputs)
    {
        if (!first) ss << ", ";
        first = false;
        ss << "{ \"label\": \"" << lbl << "\", \"nodeId\": \"" << n->id() << "\" }";
    }
    ss << "]\n";
    ss << "}";
    return ss.str();
}

inline void ShaderNode::depthFirstTraverse(const std::function<void(const Ptr&)> &dfsVisitor) const
{
    /* Avoid infinite recursion in cyclic graphs via visited set. */
    std::unordered_map<NodeId, bool> visited;
    std::function<void(const Ptr&)> impl = [&](const Ptr &n) {
        if (!n) return;
        if (visited[n->id()]) return;
        visited[n->id()] = true;

        for (const auto &[lbl, upstream] : n->connections())
        {
            (void)lbl;
            impl(upstream);
        }
        dfsVisitor(n);
    };
    impl(shared_from_this());
}

inline std::unordered_map<std::string, ShaderNode::ParameterMeta>
ShaderNode::parameterMeta() const
{
    /* Default implementation returns empty map. */
    return {};
}

} // namespace paletteflux::core::model

#endif /* PALETTEFLUX_STUDIO_CORE_MODEL_SHADERNODE_H_ */
