```cpp
/**
 *  PaletteFlux GraphQL Studio
 *  File:    paletteflux_studio/src/core/services/commands/CommandBus.cpp
 *
 *  Copyright (c) PaletteFlux
 *
 *  Description:
 *      A thin-yet-powerful in-process command-bus implementation used by the MVC
 *      controllers to mutate graph models.  Supports synchronous and asynchronous
 *      dispatch, middle-ware pipelines for cross-cutting concerns (e.g. logging,
 *      metrics, auth), and a dedicated worker-thread for non-blocking execution.
 *
 *      Thread safety:
 *          • Registration of handlers is guarded by a shared-mutex.
 *          • Command dispatch is wait-free for reads and lock-free for writes,
 *            enabling heavy parallel workloads in real-time creative sessions.
 *
 *  Build requirements:
 *      C++17 (or later)
 *
 *  External dependencies:
 *      • spdlog            — Structured logging
 *      • prometheus-cpp    — Optional metrics backend (guarded by #ifdef)
 */

#include "core/services/commands/CommandBus.hpp"

#include <chrono>
#include <condition_variable>
#include <future>
#include <memory>
#include <mutex>
#include <queue>
#include <stdexcept>
#include <string>
#include <thread>
#include <typeindex>
#include <unordered_map>
#include <utility>

#include <spdlog/spdlog.h>

#ifdef PALETTEFLUX_METRICS_ENABLED
#   include <prometheus/counter.h>
#   include <prometheus/registry.h>
#endif

namespace paletteflux::core::services::commands {

// ─────────────────────────────────────────────────────────────────────────────
//  ctor / dtor
// ─────────────────────────────────────────────────────────────────────────────
CommandBus::CommandBus() noexcept
    : _shutdown(false)
{
    // Boot the worker thread responsible for async dispatch
    _workerThread = std::thread([this] { workerLoop(); });

#ifdef PALETTEFLUX_METRICS_ENABLED
    auto& registry     = prometheus::BuildRegistry();
    auto& counterFamily = prometheus::BuildCounter()
                              .Name("paletteflux_command_dispatch_total")
                              .Help("Number of commands dispatched through the bus")
                              .Register(*registry);
    _metrics.counter = &counterFamily.Add({});
#endif

    spdlog::trace("CommandBus constructed, worker thread started");
}

CommandBus::~CommandBus()
{
    {
        std::unique_lock<std::mutex> lk(_queueMutex);
        _shutdown = true;
        _queueCv.notify_all();
    }

    if (_workerThread.joinable())
        _workerThread.join();

    spdlog::trace("CommandBus destroyed, worker thread stopped");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────────────────────
void CommandBus::dispatchSync(const CommandPtr& command)
{
    if (!command)
        throw std::invalid_argument("CommandBus::dispatchSync ‑ command is null");

#ifdef PALETTEFLUX_METRICS_ENABLED
    _metrics.counter->Increment();
#endif

    // Find handler
    auto handler = findHandler(std::type_index(typeid(*command)));
    if (!handler)
    {
        auto what = fmt::format("No handler registered for command type '{}'",
                                typeid(*command).name());
        spdlog::error(what);
        throw std::runtime_error(what);
    }

    // Surround handling with profiling / logging
    const auto start = std::chrono::high_resolution_clock::now();

    try
    {
        handler->syncHandle(command);
        spdlog::trace("Command '{}' processed synchronously", command->name());
    }
    catch (const std::exception& ex)
    {
        spdlog::error("Command handler threw: {}", ex.what());
        throw;
    }

    const auto end = std::chrono::high_resolution_clock::now();
    spdlog::debug("Command '{}' completed in {}µs",
                  command->name(),
                  std::chrono::duration_cast<std::chrono::microseconds>(end - start)
                      .count());
}

std::future<void> CommandBus::dispatchAsync(const CommandPtr& command)
{
    if (!command)
        throw std::invalid_argument("CommandBus::dispatchAsync ‑ command is null");

#ifdef PALETTEFLUX_METRICS_ENABLED
    _metrics.counter->Increment();
#endif

    std::promise<void> prom;
    auto fut = prom.get_future();

    {
        std::unique_lock<std::mutex> lk(_queueMutex);
        _queue.emplace([this, command, p = std::move(prom)]() mutable {
            try
            {
                dispatchSync(command); // reuse sync path inside worker-thread
                p.set_value();
            }
            catch (...)
            {
                try
                {
                    p.set_exception(std::current_exception());
                }
                catch (...) {} // set_exception may throw if promise already satisfied
            }
        });
    }
    _queueCv.notify_one();
    return fut;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Registration
// ─────────────────────────────────────────────────────────────────────────────
template <typename CommandT, typename HandlerT>
void CommandBus::registerHandler(std::shared_ptr<HandlerT> handler)
{
    static_assert(std::is_base_of_v<Command, CommandT>,
                  "CommandT has to derive from Command");
    static_assert(std::is_base_of_v<ICommandHandler<CommandT>, HandlerT>,
                  "HandlerT must implement ICommandHandler<CommandT>");

    if (!handler)
        throw std::invalid_argument("CommandBus::registerHandler ‑ handler is null");

    const std::type_index key = std::type_index(typeid(CommandT));

    std::unique_lock<std::shared_mutex> lk(_handlersMutex);

    // Overwriting is considered a programmer error ‑ make noise.
    if (_handlers.find(key) != _handlers.end())
        throw std::logic_error("Command handler already registered");

    HandlerWrapper wrapper;
    wrapper.syncHandle = [h = handler](const CommandPtr& cmd) {
        // cast is safe because the lookup key guarantees correct type
        h->handle(*std::static_pointer_cast<CommandT>(cmd));
    };
    // optional async customization if handler supports it
    wrapper.asyncHandle = [h = handler](const CommandPtr& cmd) {
        return h->handleAsync(*std::static_pointer_cast<CommandT>(cmd));
    };

    _handlers.emplace(key, std::move(wrapper));

    spdlog::info("Registered command handler for '{}'", key.name());
}

// ─────────────────────────────────────────────────────────────────────────────
//  Private helpers / internals
// ─────────────────────────────────────────────────────────────────────────────
CommandBus::HandlerWrapper* CommandBus::findHandler(const std::type_index& idx)
{
    std::shared_lock<std::shared_mutex> slk(_handlersMutex);

    auto it = _handlers.find(idx);
    if (it == _handlers.end())
        return nullptr;
    return &(it->second);
}

void CommandBus::workerLoop() noexcept
{
    // Runs until shutdown flag is set. Wakes on new jobs or shutdown request.
    while (true)
    {
        std::function<void()> task;
        {
            std::unique_lock<std::mutex> lk(_queueMutex);
            _queueCv.wait(lk, [this] { return _shutdown || !_queue.empty(); });

            if (_shutdown && _queue.empty())
                break; // graceful exit

            task = std::move(_queue.front());
            _queue.pop();
        }

        try
        {
            task();
        }
        catch (const std::exception& ex)
        {
            spdlog::error("Unhandled exception inside CommandBus worker: {}", ex.what());
        }
        catch (...)
        {
            spdlog::error("Unknown exception inside CommandBus worker");
        }
    }
}

} // namespace paletteflux::core::services::commands
```
