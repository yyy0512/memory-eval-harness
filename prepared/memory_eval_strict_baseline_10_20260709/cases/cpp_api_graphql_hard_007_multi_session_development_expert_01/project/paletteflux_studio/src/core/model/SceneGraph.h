```cpp
#pragma once
/**************************************************************************************************
 *  PaletteFlux GraphQL Studio
 *  File: SceneGraph.h
 *
 *  Description:
 *  ----------------------------------------------------------------------------
 *  Thread-safe, in-memory representation of a creative scene-graph. Each node in the graph
 *  can represent any creative asset (brush stroke, shader node, sound layer, etc.). The
 *  SceneGraph is an observable model element: callers may subscribe to mutation events to
 *  implement real-time collaborative editing, websocket pushes, audit logging, or cache
 *  invalidation.
 *
 *  The public API intentionally mirrors common graph operations (CRUD, traversal) while
 *  enforcing the following invariants:
 *      • A node is uniquely identified by a stable, URL-safe UUID.
 *      • Parent/child relationships form a directed, acyclic tree (cycle-free).
 *      • All mutations are guarded by a shared_mutex to guarantee thread safety.
 *
 *  NOTE: This header provides an inline, header-only implementation to maximise
 *  composability throughout the MVC core layer (link-time reduction, easier unit testing).
 *
 **************************************************************************************************/

#include <string>
#include <vector>
#include <unordered_map>
#include <unordered_set>
#include <memory>
#include <shared_mutex>
#include <mutex>
#include <functional>
#include <optional>
#include <stdexcept>
#include <sstream>
#include <chrono>

#include <nlohmann/json.hpp>          // 3rd-party (https://github.com/nlohmann/json)
#include <boost/uuid/uuid.hpp>        // 3rd-party (Boost)
#include <boost/uuid/random_generator.hpp>
#include <boost/uuid/uuid_io.hpp>

namespace paletteflux::studio::core::model
{

//-------------------------------------------------------------------------------------------------
// Type aliases
//-------------------------------------------------------------------------------------------------
using NodeId           = boost::uuids::uuid;
using Json             = nlohmann::json;
using Clock            = std::chrono::steady_clock;
using TimePoint        = Clock::time_point;

//-------------------------------------------------------------------------------------------------
// Util: UUID helpers
//-------------------------------------------------------------------------------------------------
inline NodeId generateUuid()
{
    static thread_local boost::uuids::random_generator gen;
    return gen();
}

inline std::string to_string(const NodeId& id)
{
    return boost::uuids::to_string(id);
}

//-------------------------------------------------------------------------------------------------
// Forward declarations
//-------------------------------------------------------------------------------------------------
class SceneGraph;

//-------------------------------------------------------------------------------------------------
// SceneNode
//-------------------------------------------------------------------------------------------------
class SceneNode : public std::enable_shared_from_this<SceneNode>
{
public:
    using Ptr           = std::shared_ptr<SceneNode>;
    using WeakPtr       = std::weak_ptr<SceneNode>;
    using Children      = std::vector<Ptr>;
    using MetaData      = Json;

    enum class Kind
    {
        Unknown,
        BrushStroke,
        ShaderNode,
        SoundLayer,
        AnimationCurve,
        Folder          // purely organisational
    };

    struct Transform
    {
        // Minimal 2D/3D transform payload. Extend as needed.
        float tx{0}, ty{0}, tz{0};
        float rx{0}, ry{0}, rz{0};
        float sx{1}, sy{1}, sz{1};

        Json toJson() const
        {
            return Json{
                {"translate", {tx, ty, tz}},
                {"rotate",    {rx, ry, rz}},
                {"scale",     {sx, sy, sz}}
            };
        }
    };

public:
    // Construction -----------------------------------------------------------
    explicit SceneNode(Kind kind        = Kind::Unknown,
                       std::string name = {},
                       MetaData meta    = {})
        : _id(generateUuid()),
          _kind(kind),
          _name(std::move(name)),
          _metadata(std::move(meta)),
          _createdAt(Clock::now()),
          _updatedAt(_createdAt)
    {}

    NodeId            id()        const noexcept { return _id; }
    const std::string& name()     const noexcept { return _name; }
    Kind              kind()     const noexcept { return _kind; }
    const MetaData&   meta()     const noexcept { return _metadata; }
    const Transform&  transform() const noexcept { return _transform; }
    TimePoint         createdAt() const noexcept { return _createdAt; }
    TimePoint         updatedAt() const noexcept { return _updatedAt; }

    Children          children()  const
    {
        std::shared_lock lock(_mutex);
        return _children;
    }

    Ptr parent() const
    {
        std::shared_lock lock(_mutex);
        return _parent.lock();
    }

    // Mutations --------------------------------------------------------------
    void setName(std::string name)
    {
        {
            std::unique_lock lock(_mutex);
            _name = std::move(name);
            touch();
        }
    }

    void setMeta(MetaData meta)
    {
        {
            std::unique_lock lock(_mutex);
            _metadata = std::move(meta);
            touch();
        }
    }

    void setTransform(Transform t)
    {
        {
            std::unique_lock lock(_mutex);
            _transform = std::move(t);
            touch();
        }
    }

private:
    friend class SceneGraph;

    void setParent(Ptr newParent)
    {
        std::unique_lock lock(_mutex);
        _parent = newParent;
        touch();
    }

    void addChild(const Ptr& node)
    {
        std::unique_lock lock(_mutex);
        _children.push_back(node);
        touch();
    }

    void removeChild(const NodeId& id)
    {
        std::unique_lock lock(_mutex);
        auto it = std::remove_if(_children.begin(), _children.end(),
                                 [&](const Ptr& child){ return child->id() == id; });
        _children.erase(it, _children.end());
        touch();
    }

    void touch() { _updatedAt = Clock::now(); }

private:
    NodeId     _id;
    Kind       _kind{Kind::Unknown};
    std::string _name;
    MetaData    _metadata;
    Transform   _transform;

    WeakPtr     _parent;
    Children    _children;

    TimePoint   _createdAt;
    TimePoint   _updatedAt;

    mutable std::shared_mutex _mutex;
};

//-------------------------------------------------------------------------------------------------
// SceneGraph
//-------------------------------------------------------------------------------------------------
class SceneGraph
{
public:
    using NodePtr         = SceneNode::Ptr;
    using ConstNodePtr    = std::shared_ptr<const SceneNode>;
    using NodeMap         = std::unordered_map<NodeId, NodePtr>;
    using Callback        = std::function<void(const SceneGraph&, const SceneNode&)>;

    enum class Event
    {
        NodeAdded,
        NodeRemoved,
        NodeMoved,
        NodeUpdated
    };

    struct Subscription
    {
        uint64_t         handle;
        Event            event;
    };

public:
    SceneGraph() = default;
    SceneGraph(const SceneGraph&)            = delete;
    SceneGraph& operator=(const SceneGraph&) = delete;

    // ROOT -------------------------------------------------------------------
    NodePtr root()
    {
        std::shared_lock lock(_mutex);
        return _root;
    }

    // Create -----------------------------------------------------------------
    NodePtr createNode(SceneNode::Kind kind,
                       std::string name = {},
                       SceneNode::MetaData meta = {})
    {
        auto node = std::make_shared<SceneNode>(kind, std::move(name), std::move(meta));

        {
            std::unique_lock lock(_mutex);
            // If no root present, make this node the root.
            if (!_root)
            {
                _root = node;
            }
            _nodes.emplace(node->id(), node);
        }

        notify(Event::NodeAdded, *node);
        return node;
    }

    // Attach (Add child) ------------------------------------------------------
    void attach(const NodeId& parentId, const NodeId& childId)
    {
        NodePtr parent, child;
        {
            std::unique_lock lock(_mutex);
            parent = findNodeInternal(parentId);
            child  = findNodeInternal(childId);

            if (!parent || !child)
                throw std::invalid_argument("attach(): parent or child not found");

            if (isAncestor(childId, parentId))
                throw std::logic_error("attach(): operation would create a cycle");

            if (auto oldParent = child->parent())
                oldParent->removeChild(childId);

            child->setParent(parent);
            parent->addChild(child);
        }

        notify(Event::NodeMoved, *child);
    }

    // Detach (Remove parent link) --------------------------------------------
    void detach(const NodeId& childId)
    {
        NodePtr child;
        {
            std::unique_lock lock(_mutex);
            child = findNodeInternal(childId);
            if (!child)
                throw std::invalid_argument("detach(): node not found");

            if (auto oldParent = child->parent())
                oldParent->removeChild(childId);

            child->setParent(nullptr);
        }

        notify(Event::NodeMoved, *child);
    }

    // Delete -----------------------------------------------------------------
    void removeNode(const NodeId& id)
    {
        NodePtr node;
        {
            std::unique_lock lock(_mutex);

            node = findNodeInternal(id);
            if (!node)
                throw std::invalid_argument("removeNode(): node not found");

            // Disallow deleting root directly
            if (node == _root)
                throw std::logic_error("removeNode(): deleting root node is not allowed");

            // Recursively collect nodes to delete
            std::unordered_set<NodeId> toDelete;
            collectSubTreeIds(node, toDelete);

            // Remove nodes from map
            for (const auto& nid : toDelete)
                _nodes.erase(nid);

            // Remove link from parent
            if (auto parent = node->parent())
                parent->removeChild(id);
        }

        notify(Event::NodeRemoved, *node);
    }

    // Query ------------------------------------------------------------------
    NodePtr findNode(const NodeId& id) const
    {
        std::shared_lock lock(_mutex);
        return findNodeInternal(id);
    }

    template <typename Fn>
    void depthFirst(NodePtr node, Fn&& fn) const
    {
        if (!node) return;
        fn(node);
        for (const auto& child : node->children())
            depthFirst(child, fn);
    }

    // Observation ------------------------------------------------------------
    Subscription on(Event ev, Callback cb)
    {
        if (!cb) throw std::invalid_argument("callback must be valid");

        std::unique_lock lock(_subMutex);
        const uint64_t handle = ++_nextHandle;
        _subscribers.emplace(handle, Subscriber{ev, std::move(cb)});
        return {handle, ev};
    }

    void unsubscribe(uint64_t handle)
    {
        std::unique_lock lock(_subMutex);
        _subscribers.erase(handle);
    }

private:
    // Utility ----------------------------------------------------------------
    NodePtr findNodeInternal(const NodeId& id) const
    {
        auto it = _nodes.find(id);
        return it == _nodes.end() ? nullptr : it->second;
    }

    bool isAncestor(const NodeId& ancestorId, const NodeId& nodeId) const
    {
        auto current = findNodeInternal(nodeId);
        while (current)
        {
            if (current->id() == ancestorId)
                return true;
            current = current->parent();
        }
        return false;
    }

    void collectSubTreeIds(const NodePtr& node, std::unordered_set<NodeId>& out) const
    {
        out.insert(node->id());
        for (const auto& child : node->children())
            collectSubTreeIds(child, out);
    }

    // Notification -----------------------------------------------------------
    void notify(Event ev, const SceneNode& node) const
    {
        std::vector<Callback> targets;
        {
            std::shared_lock lock(_subMutex);
            for (const auto& [_, sub] : _subscribers)
            {
                if (sub.ev == ev)
                    targets.emplace_back(sub.cb);
            }
        }

        // Invoke callbacks outside lock to avoid deadlocks
        for (auto& cb : targets)
            cb(*this, node);
    }

    struct Subscriber
    {
        Event      ev;
        Callback   cb;
    };

private:
    // Graph data -------------------------------------------------------------
    NodePtr    _root;
    NodeMap    _nodes;           // O(1) id lookup

    mutable std::shared_mutex _mutex;        // Guards _root and _nodes

    // Observer data ----------------------------------------------------------
    uint64_t _nextHandle{0};
    std::unordered_map<uint64_t, Subscriber> _subscribers;
    mutable std::shared_mutex _subMutex;     // Guards _subscribers
};

} // namespace paletteflux::studio::core::model
```