<?php
declare(strict_types=1);

/**
 * This file is part of the ProdSecure Orchestrator system-security suite.
 *
 * (c) 2024 ProdSecure, Inc. <opensource@prodsecure.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

namespace ProdSecureOrchestrator\Domain\EventProcessing\Handlers\Strategy;

use ProdSecureOrchestrator\Domain\EventProcessing\EventInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\Handlers\Context\HandlerContextInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\Handlers\Result\HandlingResultInterface;

/**
 * HandlerStrategyInterface
 *
 * A Strategy implementation encapsulates the algorithm that a single Chain-of-Responsibility
 * handler should apply when it becomes responsible for an {@see EventInterface}.  The same
 * handler may expose multiple strategies (e.g. "default", "throttled", "panic-mode") that
 * can be swapped at runtime based on contextual signals such as environment, rate-limits,
 * or administrator preferences.
 *
 * Implementations MUST be stateless and thread-safe.  Any state that needs to be shared
 * between invocations should be stored in {@see HandlerContextInterface}.
 */
interface HandlerStrategyInterface
{
    /**
     * Human-readable, unique name for diagnostics and configuration.
     */
    public function getName(): string;

    /**
     * Returns a numerical priority that the orchestrator may use to order multiple
     * strategies that all claim to support a given event.  Higher numbers win.
     *
     * @return int Positive integer; strategies with the same value are considered equal.
     */
    public function getPriority(): int;

    /**
     * Determines if this strategy is applicable to the supplied event.
     *
     * Implementations SHOULD short-circuit quickly (O(1)) and MUST NOT mutate either the
     * event or the context in this method.
     *
     * @param EventInterface $event   The domain event being evaluated.
     * @param HandlerContextInterface $context Immutable, per-request context.
     *
     * @return bool True if the strategy can handle the event, false otherwise.
     */
    public function supports(EventInterface $event, HandlerContextInterface $context): bool;

    /**
     * Performs the actual handling logic.
     *
     * Implementations MAY mutate the context to share state with downstream handlers.
     * Any exception thrown from this method will be caught by the orchestrator and
     * wrapped into a standardized failure {@see HandlingResultInterface::STATUS_FAILURE}.
     *
     * @param EventInterface          $event   The event to process.
     * @param HandlerContextInterface $context Mutable context shared across the chain.
     *
     * @throws \Throwable Implementations may throw any Throwable; the orchestrator will
     *                    convert it into a failed HandlingResult and log appropriately.
     *
     * @return HandlingResultInterface A value object describing the outcome.
     */
    public function handle(EventInterface $event, HandlerContextInterface $context): HandlingResultInterface;
}