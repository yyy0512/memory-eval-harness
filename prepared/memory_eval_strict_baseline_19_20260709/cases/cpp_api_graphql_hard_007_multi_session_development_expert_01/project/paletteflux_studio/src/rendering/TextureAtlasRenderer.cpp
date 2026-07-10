#include "TextureAtlasRenderer.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <future>
#include <iterator>
#include <mutex>
#include <numeric>
#include <optional>
#include <stdexcept>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include <spdlog/spdlog.h>

// Third-party single-header image writer.
// The header is expected to be available in the include path.
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include <stb_image_write.h>

namespace paletteflux::rendering
{

/*───────────────────────────────────────────────────────────────────────────────
 * Helper types
 *─────────────────────────────────────────────────────────────────────────────*/

namespace
{
    struct Rect
    {
        uint32_t x      = 0;
        uint32_t y      = 0;
        uint32_t width  = 0;
        uint32_t height = 0;

        [[nodiscard]] bool fits(uint32_t w, uint32_t h) const noexcept
        {
            return w <= width && h <= height;
        }
    };

    // Simple shelf-based packer. Not the most optimal, yet deterministic,
    // cache-friendly, and O(n) for practical purposes.
    class ShelfPacker
    {
    public:
        ShelfPacker(uint32_t maxDim, uint32_t padding)
            : m_maxDim{maxDim}
            , m_padding{padding}
        {}

        /**
         * Attempts to place the rectangle in the atlas.
         * Returns the position or std::nullopt if it does not fit.
         */
        std::optional<Rect> place(uint32_t w, uint32_t h)
        {
            // First bin to be used?
            if (m_shelves.empty())
            {
                if (w > m_maxDim || h > m_maxDim)
                    return std::nullopt;

                m_shelves.push_back(
                    Shelf{0, h + m_padding, 0, w + m_padding});
                return Rect{0, 0, w, h};
            }

            // 1. Try to fit in existing shelves
            for (auto& shelf : m_shelves)
            {
                if (h <= shelf.height && shelf.xCursor + w + m_padding <= m_maxDim)
                {
                    Rect r{shelf.xCursor, shelf.yOffset, w, h};
                    shelf.xCursor += w + m_padding;
                    return r;
                }
            }

            // 2. Create a new shelf
            uint32_t requiredHeight = std::accumulate(
                m_shelves.cbegin(), m_shelves.cend(), 0u,
                [](uint32_t acc, const Shelf& s) { return acc + s.height; });

            if (requiredHeight + h + m_padding > m_maxDim || w > m_maxDim)
                return std::nullopt;

            uint32_t yOffset = requiredHeight;
            m_shelves.push_back(
                Shelf{0, h + m_padding, yOffset, w + m_padding});
            return Rect{0, yOffset, w, h};
        }

        [[nodiscard]] uint32_t width() const noexcept
        {
            uint32_t maxWidth = 0;
            for (const auto& shelf : m_shelves)
            {
                maxWidth = std::max(maxWidth, shelf.xCursor);
            }
            return maxWidth;
        }

        [[nodiscard]] uint32_t height() const noexcept
        {
            return std::accumulate(
                m_shelves.cbegin(), m_shelves.cend(), 0u,
                [](uint32_t acc, const Shelf& s) { return acc + s.height; });
        }

    private:
        struct Shelf
        {
            uint32_t xCursor   = 0;  // x offset where next rect can be placed
            uint32_t height    = 0;  // shelf height incl. padding
            uint32_t yOffset   = 0;  // y start in atlas
            uint32_t firstRect = 0;  // width of first rect for initial placement
        };

        uint32_t            m_maxDim;
        uint32_t            m_padding;
        std::vector<Shelf>  m_shelves;
    };

    constexpr uint32_t BYTES_PER_PIXEL = 4;  // RGBA8
} // namespace

/*───────────────────────────────────────────────────────────────────────────────
 * TextureAtlasRenderer implementation
 *─────────────────────────────────────────────────────────────────────────────*/

TextureAtlasRenderer::TextureAtlasRenderer(AtlasSettings settings)
    : m_settings{std::move(settings)}
{
    if (m_settings.maxDimension == 0 || (m_settings.maxDimension & (m_settings.maxDimension - 1)) != 0)
    {
        throw std::invalid_argument(
            "TextureAtlasRenderer: maxDimension must be power-of-two and > 0");
    }
}

void TextureAtlasRenderer::addTexture(const AssetID& id,
                                      std::vector<std::byte> pixels,
                                      uint32_t width,
                                      uint32_t height)
{
    std::scoped_lock lock{m_mutex};

    if (pixels.size() != static_cast<std::size_t>(width) * height * BYTES_PER_PIXEL)
    {
        throw std::invalid_argument("TextureAtlasRenderer: pixel buffer size mismatch");
    }

    if (m_textures.count(id))
    {
        throw std::invalid_argument("TextureAtlasRenderer: duplicate asset id");
    }
    m_textures.emplace(id, TextureEntry{std::move(pixels), width, height});
}

bool TextureAtlasRenderer::compile()
{
    std::scoped_lock lock{m_mutex};

    if (m_textures.empty())
    {
        spdlog::warn("TextureAtlasRenderer: no textures to compile, skipping.");
        return false;
    }

    // 1. Sort textures largest-to-smallest to improve packing density.
    std::vector<std::pair<AssetID, TextureEntry*>> sorted;
    sorted.reserve(m_textures.size());
    for (auto& [id, tex] : m_textures) { sorted.emplace_back(id, &tex); }

    std::sort(sorted.begin(), sorted.end(),
              [](const auto& a, const auto& b)
              {
                  auto areaA = a.second->width * a.second->height;
                  auto areaB = b.second->width * b.second->height;
                  return areaA > areaB; // descending
              });

    ShelfPacker packer{m_settings.maxDimension, m_settings.padding};

    // 2. Place textures.
    for (auto& [id, texPtr] : sorted)
    {
        auto maybePos = packer.place(texPtr->width, texPtr->height);
        if (!maybePos)
        {
            spdlog::error("TextureAtlasRenderer: could not fit texture {} ({}x{}) into atlas.",
                          id, texPtr->width, texPtr->height);
            return false;
        }

        texPtr->atlasRegion = *maybePos;
    }

    m_atlasWidth  = std::max<uint32_t>(1, nextPOT(packer.width()));
    m_atlasHeight = std::max<uint32_t>(1, nextPOT(packer.height()));

    // 3. Allocate atlas buffer.
    const std::size_t atlasByteSize =
        static_cast<std::size_t>(m_atlasWidth) * m_atlasHeight * BYTES_PER_PIXEL;
    m_atlasPixels.assign(atlasByteSize, std::byte{0});

    // 4. Copy texture bits. Parallel copy to leverage multi-core.
    std::vector<std::future<void>> jobs;
    jobs.reserve(sorted.size());

    for (const auto& [id, texPtr] : sorted)
    {
        jobs.emplace_back(std::async(std::launch::async,
                                     [this, texPtr]
                                     {
                                         blitToAtlas(*texPtr);
                                     }));
    }
    for (auto& j : jobs) { j.wait(); }

    spdlog::info("TextureAtlasRenderer: compiled {} textures into {}x{} atlas ({} KiB).",
                 sorted.size(),
                 m_atlasWidth,
                 m_atlasHeight,
                 atlasByteSize / 1024);

    return true;
}

std::vector<std::byte> TextureAtlasRenderer::atlasData() const
{
    std::scoped_lock lock{m_mutex};
    return m_atlasPixels;
}

std::unordered_map<AssetID, Rect> TextureAtlasRenderer::atlasMap() const
{
    std::scoped_lock lock{m_mutex};
    std::unordered_map<AssetID, Rect> map;
    map.reserve(m_textures.size());

    for (const auto& [id, tex] : m_textures)
    {
        if (!tex.atlasRegion)
            continue;
        map.emplace(id, *tex.atlasRegion);
    }
    return map;
}

bool TextureAtlasRenderer::writePng(const std::filesystem::path& path) const
{
    std::scoped_lock lock{m_mutex};

    if (m_atlasPixels.empty())
    {
        spdlog::error("TextureAtlasRenderer: compile() must be invoked before writePng().");
        return false;
    }

    if (!path.has_extension() || path.extension() != ".png")
    {
        spdlog::warn("TextureAtlasRenderer: expected .png extension on path {}, forcing.", path.string());
    }

    const auto result = stbi_write_png(
        path.string().c_str(),              // filename
        static_cast<int>(m_atlasWidth),     // w
        static_cast<int>(m_atlasHeight),    // h
        BYTES_PER_PIXEL,                    // channels
        m_atlasPixels.data(),               // data
        static_cast<int>(m_atlasWidth * BYTES_PER_PIXEL)); // stride

    if (!result)
    {
        spdlog::error("TextureAtlasRenderer: failed to write atlas PNG to {}", path.string());
        return false;
    }

    spdlog::info("TextureAtlasRenderer: atlas written to {}", path.string());
    return true;
}

/*───────────────────────────────────────────────────────────────────────────────
 * Private helpers
 *─────────────────────────────────────────────────────────────────────────────*/

void TextureAtlasRenderer::blitToAtlas(const TextureEntry& tex)
{
    if (!tex.atlasRegion)
        return;

    const auto& rect = *tex.atlasRegion;

    const std::byte* src = tex.pixels.data();
    for (uint32_t row = 0; row < rect.height; ++row)
    {
        std::byte* dst = m_atlasPixels.data()
            + ((rect.y + row) * m_atlasWidth + rect.x) * BYTES_PER_PIXEL;

        const std::byte* srcRow = src + row * tex.width * BYTES_PER_PIXEL;

        std::memcpy(dst, srcRow, static_cast<std::size_t>(rect.width) * BYTES_PER_PIXEL);
    }
}

uint32_t TextureAtlasRenderer::nextPOT(uint32_t v) noexcept
{
    // Round up to power-of-two. https://graphics.stanford.edu/~seander/bithacks.html
    v--;
    v |= v >> 1u;
    v |= v >> 2u;
    v |= v >> 4u;
    v |= v >> 8u;
    v |= v >> 16u;
    v++;
    return v;
}

} // namespace paletteflux::rendering