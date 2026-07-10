```cpp
#pragma once
/**
 * PaletteFlux GraphQL Studio – Rendering Sub-system
 * -------------------------------------------------
 * File:    paletteflux_studio/src/rendering/IRenderer.h
 * License: Apache-2.0
 *
 * The rendering subsystem is responsible for turning domain-level “creative
 * assets” (brush strokes, shader nodes, animation curves, …) into concrete
 * visual artifacts such as texture atlases, GLSL snippets, or preview frames
 * that can be streamed over the network.  This header specifies the primary
 * abstraction – IRenderer – that concrete back-ends (e.g. Vulkan, OpenGL,
 * Metal) must implement.  The interface is intentionally agnostic of any
 * single graphics API while still exposing enough detail for high-level
 * orchestration, performance monitoring, and robust error handling.
 */

#include <cstdint>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>
#include <functional>
#include <chrono>
#include <stdexcept>

namespace paletteflux::rendering
{

/* =========================================================================
 *  Enumerations & Flags
 * ========================================================================= */

/** Enumerates all official, production-grade rendering back-ends. */
enum class RenderBackend
{
    Auto,       //!< Let the runtime choose the most performant backend
    Vulkan,
    OpenGL,
    Direct3D12,
    Metal,
};

/** Common GPU resource formats needed by the studio. */
enum class PixelFormat : std::uint8_t
{
    Unknown = 0,
    R8G8B8A8_UNorm,
    R16G16B16A16_Float,
    R32G32B32A32_Float,
    D24S8,      //!< 24-bit depth, 8-bit stencil
};

/** Feature flags queried at run-time. */
enum class RendererFeature : std::uint32_t
{
    None                = 0u,
    ComputeShaders      = 1u << 0,
    RayTracing          = 1u << 1,
    MeshShaders         = 1u << 2,
    BindlessTextures    = 1u << 3,
};
inline RendererFeature operator|(RendererFeature lhs, RendererFeature rhs)
{
    return static_cast<RendererFeature>(
        static_cast<std::uint32_t>(lhs) | static_cast<std::uint32_t>(rhs));
}
inline RendererFeature& operator|=(RendererFeature& lhs, RendererFeature rhs)
{
    lhs = lhs | rhs;
    return lhs;
}
inline bool operator&(RendererFeature lhs, RendererFeature rhs)
{
    return (static_cast<std::uint32_t>(lhs) & static_cast<std::uint32_t>(rhs)) != 0u;
}

/* =========================================================================
 *  Structs & Descriptors
 * ========================================================================= */

/**
 * Minimal logging interface; the concrete studio implementation provides
 * an adapter that forwards messages to either spdlog, Boost.Log, or the
 * application’s central monitoring service.
 */
struct ILogger
{
    virtual ~ILogger() = default;
    virtual void info (std::string_view msg) noexcept = 0;
    virtual void warn (std::string_view msg) noexcept = 0;
    virtual void error(std::string_view msg) noexcept = 0;
};

/** Describes the capabilities requested by the caller when creating a renderer. */
struct RendererCapabilities
{
    RenderBackend         backend              = RenderBackend::Auto;
    RendererFeature       requiredFeatures     = RendererFeature::None;
    std::uint32_t         maxFramesInFlight    = 2u;
    bool                  enableValidation     = false;     //!< GPU validation / debug layers
    std::optional<void*>  nativeWindowHandle;              //!< OS-specific window handle, if any
};

/** Statistics produced per frame for performance instrumentation. */
struct RenderStats
{
    std::chrono::nanoseconds cpuTime       = std::chrono::nanoseconds{0};
    std::chrono::nanoseconds gpuTime       = std::chrono::nanoseconds{0};
    std::uint32_t drawCalls               = 0u;
    std::uint32_t pipelineChanges         = 0u;
};

/**
 * Simple descriptor for a render target.  Some graph nodes (“scenes”) may wish
 * to output directly into off-screen framebuffers for later composition.
 */
struct RenderTargetDesc
{
    std::uint32_t width             = 0;
    std::uint32_t height            = 0;
    PixelFormat   colorFormat       = PixelFormat::R8G8B8A8_UNorm;
    PixelFormat   depthStencilFmt   = PixelFormat::D24S8;
};

/* =========================================================================
 *  Exception types
 * ========================================================================= */

class RendererException : public std::runtime_error
{
public:
    explicit RendererException(const std::string& what)
        : std::runtime_error(what)
    {}
};

/* =========================================================================
 *  Forward Declarations
 * ========================================================================= */
namespace scene
{
    class SceneGraph;     // Forward declaration; defined in scene graph module
}

/* =========================================================================
 *  Interface: IRenderer
 * ========================================================================= */

/**
 * The heart of PaletteFlux’s rendering subsystem.  All concrete back-ends
 * derive from this pure virtual interface.  No direct instances are created;
 * instead, use createRenderer(…) defined further below.
 */
class IRenderer
{
public:
    virtual ~IRenderer() = default;

    /* ---------------------------------------------------------------------
     *  Lifecycle
     * ------------------------------------------------------------------ */

    /**
     * Initializes the renderer with the requested capabilities.  Concrete
     * implementations must throw RendererException on failure.
     */
    virtual void initialize(const RendererCapabilities& caps) = 0;

    /** Queries whether initialize(..) has successfully completed. */
    [[nodiscard]] virtual bool isInitialized() const noexcept = 0;

    /**
     * Blocks until all in-flight work is finished and frees associated GPU
     * resources.  After shutdown() the instance is undefined; clients are
     * expected to destroy and recreate a new renderer when necessary.
     */
    virtual void shutdown() noexcept = 0;

    /* ---------------------------------------------------------------------
     *  Per-frame Control
     * ------------------------------------------------------------------ */

    /**
     * Prepares a new frame.  deltaTime is expressed in seconds and is meant
     * for animations or frame time estimations inside the render graph.
     */
    virtual void beginFrame(double deltaTime) = 0;

    /**
     * Renders a complete scene graph to the default back buffer or an
     * off-screen target if one is currently bound.
     */
    virtual void renderScene(const scene::SceneGraph& scene) = 0;

    /**
     * Ends the current frame, flushes command buffers, and presents / copies
     * the rendered image to its final destination.
     */
    virtual void endFrame() = 0;

    /* ---------------------------------------------------------------------
     *  Window & Surface Controls
     * ------------------------------------------------------------------ */

    /**
     * Resizes the primary swap chain or currently bound render target.
     * Implementations should perform resource re-creation lazily for maximum
     * efficiency.  width/height of zero are ignored.
     */
    virtual void resize(std::uint32_t width, std::uint32_t height) = 0;

    /**
     * Binds an off-screen render target described by ‘desc’.  Passing
     * std::nullopt binds the swap chain back buffer again.
     */
    virtual void setRenderTarget(std::optional<RenderTargetDesc> desc) = 0;

    /* ---------------------------------------------------------------------
     *  Miscellaneous
     * ------------------------------------------------------------------ */

    /** Retrieves the back-end actually chosen by the renderer. */
    [[nodiscard]] virtual RenderBackend backend() const noexcept = 0;

    /** True if the given feature is supported at runtime. */
    [[nodiscard]] virtual bool supportsFeature(RendererFeature feature) const noexcept = 0;

    /** Retrieves up-to-date statistics from the last completed frame. */
    [[nodiscard]] virtual RenderStats statistics() const noexcept = 0;

    /**
     * Grabs the pixel data from the last rendered frame.  The implementation
     * may return a zero-sized span<> if the operation is unsupported or the
     * data is not yet available on the CPU.
     */
    [[nodiscard]] virtual std::span<const std::byte> captureFramebuffer() = 0;

    /**
     * Registers a one-shot callback that is invoked asynchronously after the
     * next frame has been fully rendered and read back from the GPU.  Use this
     * mechanism to stream thumbnails without stalling the render thread.
     */
    using FrameCaptureCallback = std::function<void(std::vector<std::byte> /*RGBA8*/)>;

    virtual void enqueueFrameCapture(FrameCaptureCallback cb) = 0;

    /** Provides access to a logger instance owned by the renderer. */
    [[nodiscard]] virtual ILogger& logger() noexcept = 0;
};

/* =========================================================================
 *  Factory Function
 * ========================================================================= */

/**
 * Creates a renderer instance using the specified backend.  If `caps.backend`
 * is RenderBackend::Auto, the factory probes the host machine for the most
 * performant choice that satisfies all required features.  The function
 * returns nullptr if no suitable backend is available.
 *
 * Example:
 *   auto renderer = paletteflux::rendering::createRenderer({...});
 *   if (!renderer)
 *       throw std::runtime_error("No supported GPU backend found.");
 */
[[nodiscard]] std::unique_ptr<IRenderer>
createRenderer(const RendererCapabilities& caps,
               std::unique_ptr<ILogger>     logger);

/* =========================================================================
 *  Inline Utilities
 * ========================================================================= */

/** Convenience sugar to test multiple features at once. */
inline bool supportsFeatures(const IRenderer& renderer, RendererFeature features)
{
    return renderer.supportsFeature(features);
}

} // namespace paletteflux::rendering
```