<?php
declare(strict_types=1);

/**
 * This file is part of the ProdSecure Orchestrator project.
 *
 * (c) 2023–present ProdSecure, Inc. <opensource@prodsecure.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

namespace ProdSecureOrchestrator\Domain\EventProcessing;

use ProdSecureOrchestrator\Domain\EventProcessing\Context\ProcessingContextInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\Event\EventInterface;
use Throwable;

/**
 * HandlerInterface
 *
 * A single unit in the Chain-of-Responsibility responsible for inspecting and,
 * when applicable, acting upon a domain event.  Each handler makes an
 * independent "supports" decision (Strategy Pattern) and either processes the
 * event or forwards it to the next handler in line.  Handlers MUST be
 * thread-safe and preferably stateless; external dependencies should therefore
 * be injected through the constructor and never stored as static properties.
 *
 * Implementations SHOULD:
 *  • Be pure or idempotent where side-effects are unavoidable.
 *  • Emit domain-specific metrics/traces for observability.
 *  • Fail fast and throw an exception when encountering inconsistent state.
 *
 * @author    ProdSecure <dev@prodsecure.io>
 * @copyright 2023
 */
interface HandlerInterface
{
    /**
     * Fluent setter used by the bootstrapper to wire the chain.
     *
     * @param HandlerInterface|null $next The next handler, or NULL when the
     *                                    current handler is the end of the chain.
     *
     * @return HandlerInterface Returns $this for fluent chain composition.
     */
    public function setNext(?HandlerInterface $next): HandlerInterface;

    /**
     * Returns the next handler in the chain, if any.
     *
     * @return HandlerInterface|null
     */
    public function getNext(): ?HandlerInterface;

    /**
     * Determines whether the current handler should process the supplied event.
     *
     * @param EventInterface $event The event to test.
     *
     * @return bool TRUE when the handler can process the event; otherwise FALSE.
     */
    public function supports(EventInterface $event): bool;

    /**
     * Performs the actual work associated with the event.
     *
     * A handler that claims support for an event MUST either:
     *  • Handle the event fully, or
     *  • Throw a Throwable to trigger upstream compensating or fallback logic.
     *
     * After processing, implementations SHOULD delegate to the next handler
     * unless the chain needs to be short-circuited.
     *
     * @param EventInterface               $event   The event under processing.
     * @param ProcessingContextInterface   $context Request-scoped bag of
     *                                              contextual data & services.
     *
     * @throws Throwable When an unrecoverable domain or infrastructure error
     *                   occurs; enables the orchestrator to trigger compensating
     *                   transactions or circuit-breaker logic.
     *
     * @return void
     */
    public function handle(EventInterface $event, ProcessingContextInterface $context): void;
}