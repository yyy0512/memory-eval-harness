"""
vitalops_orchestrator.vitalops.interfaces.cli
=============================================

Command-line interface that DevOps/SRE engineers use to interact with the
VitalOps Orchestrator.  The CLI is a *thin* wrapper around the View-Model
layer—calling into the high-level coordinators that implement business
logic—while handling argument parsing, terminal I/O, and basic telemetry.

The module purposefully stays *framework-agnostic* with respect to external
transport/protocol details (e.g., gRPC, AMQP).  All communication happens via
Python callables provided by the view-models so that we can unit-test the CLI
without standing up the full event-bus.

Design goals
------------
• Asynchronous-first: many orchestrator actions return `asyncio.Future`s that
  stream partial progress (e.g., live metrics).  
• Extensible: adding a new command requires **zero** changes to existing code—just
  register a new `click` command and use any coordinator you need.  
• Observability: automatic debug/trace logging with `--verbose` and structured
  JSON output with `--json` for machine-consumers (CI pipelines, ChatOps bots).  
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterable, Awaitable, Callable, Dict, Optional

import click

# ------------------------------------------------------------------------------
# Runtime configuration / dependency injection
# ------------------------------------------------------------------------------

# NOTE: The real implementations live in vitalops_orchestrator.vitalops.viewmodels
# We fall back to *very* light stubs so that importing this module does not crash
# the entire application during documentation builds or partial installs.

try:  # pragma: no cover
    from vitalops.viewmodels.performance import PerformanceCoordinator
    from vitalops.viewmodels.recovery import RecoveryCoordinator
    from vitalops.viewmodels.deployment import DeploymentCoordinator
except ModuleNotFoundError:  # Fallback stubs for linters/docs
    class _StubCoordinator:  # pylint: disable=too-few-public-methods
        async def noop(self, *_, **__) -> None:  # type: ignore[empty-body]
            ...

    PerformanceCoordinator = _StubCoordinator  # type: ignore[invalid-name]
    RecoveryCoordinator = _StubCoordinator  # type: ignore[invalid-name]
    DeploymentCoordinator = _StubCoordinator  # type: ignore[invalid-name]


@dataclass(slots=True)
class CLIContext:
    """
    Runtime context object injected into every Click command via ``obj``.
    """
    loop: asyncio.AbstractEventLoop
    verbose: bool
    json_out: bool

    perf_coordinator: PerformanceCoordinator
    recovery_coordinator: RecoveryCoordinator
    deployment_coordinator: DeploymentCoordinator

    def to_dict(self) -> Dict[str, Any]:
        """
        Return a dict representation suitable for pretty-printing / logging.
        """
        return {
            "loop": repr(self.loop),
            "verbose": self.verbose,
            "json_out": self.json_out,
        }


# ------------------------------------------------------------------------------
# Utility helpers
# ------------------------------------------------------------------------------

JSON = Dict[str, Any]  # Shorthand alias


def _configure_logging(verbose: bool) -> None:
    """
    Configure root logger. Called once at start-up.
    """
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        stream=sys.stderr,
    )
    logging.getLogger("asyncio").setLevel(level)
    logging.debug("Logging configured ‑- verbose=%s", verbose)


def _format_output(row: JSON | str, as_json: bool) -> str:
    if as_json:
        return json.dumps(row, default=str)
    return row if isinstance(row, str) else json.dumps(row, indent=2, default=str)


async def _stream_result(
    stream: AsyncIterable[JSON | str],
    *,
    as_json: bool,
    sink: Callable[[str], None] = click.echo,
) -> None:
    """
    Helper: consume an async generator and emit formatted lines to the sink.
    """
    async for chunk in stream:
        sink(_format_output(chunk, as_json))


def _graceful_shutdown(loop: asyncio.AbstractEventLoop) -> None:
    """
    Install signal handlers so Ctrl-C results in *graceful* cancellation rather
    than an abrupt `KeyboardInterrupt` trace dump.
    """

    def _handler(_sig: int, _frame: Any) -> None:  # noqa: D401
        logging.warning("Received shutdown signal, cancelling tasks…")
        for task in asyncio.all_tasks(loop):
            task.cancel()

    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(ValueError):  # Not all OSes support all sigs
            signal.signal(sig, _handler)


# ------------------------------------------------------------------------------
# CLI definition
# ------------------------------------------------------------------------------

@click.group(context_settings={"max_content_width": 120})
@click.option(
    "-v",
    "--verbose",
    is_flag=True,
    default=False,
    help="Enable debug logging.",
)
@click.option(
    "--json",
    "json_out",
    is_flag=True,
    default=False,
    help="Emit JSON lines (machine-readable) instead of human text.",
)
@click.pass_context
def cli(ctx: click.Context, verbose: bool, json_out: bool) -> None:
    """
    VitalOps Orchestrator command-line interface.

    Examples
    --------
    • Stream live metrics:   `vo monitor --service e-prescribing`
    • Manual rebalance:      `vo balance --service radiology-viewer`
    • Trigger blue-green:    `vo deploy --service ml-sepsis --strategy blue-green`
    """
    _configure_logging(verbose)

    # We create a *new* event loop each invocation so that nested `asyncio.run`
    # from other parts of code will not choke on a closed loop.
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _graceful_shutdown(loop)

    ctx.obj = CLIContext(
        loop=loop,
        verbose=verbose,
        json_out=json_out,
        perf_coordinator=PerformanceCoordinator(),
        recovery_coordinator=RecoveryCoordinator(),
        deployment_coordinator=DeploymentCoordinator(),
    )
    logging.debug("CLI context initialized: %s", ctx.obj.to_dict())


# ------------------------------------------------------------------------------
# Command: monitor
# ------------------------------------------------------------------------------

@cli.command()
@click.option("--service", "-s", required=True, help="Clinical micro-service name.")
@click.option(
    "--interval",
    "-i",
    default=5,
    show_default=True,
    help="Sampling interval in seconds.",
    type=click.IntRange(1, 60),
)
@click.pass_obj
def monitor(ctx: CLIContext, service: str, interval: int) -> None:
    """
    Stream live performance metrics for a given micro-service to the terminal.
    """
    async def _runner() -> None:
        logging.info("Starting metric stream for %s (interval=%ss)", service, interval)
        stream = ctx.perf_coordinator.stream_metrics(
            service=service,
            interval=interval,
        )
        await _stream_result(stream, as_json=ctx.json_out)

    ctx.loop.run_until_complete(_runner())


# ------------------------------------------------------------------------------
# Command: balance
# ------------------------------------------------------------------------------

@cli.command()
@click.option("--service", "-s", required=True, help="Target micro-service.")
@click.option(
    "--strategy",
    "-st",
    default="round-robin",
    type=click.Choice(["round-robin", "least-loaded", "latency-aware"]),
    show_default=True,
)
@click.pass_obj
def balance(ctx: CLIContext, service: str, strategy: str) -> None:
    """
    Manually trigger load balancing for a micro-service.
    """

    async def _runner() -> None:
        logging.info("Initiating manual balance for %s [strategy=%s]", service, strategy)
        result: JSON = await ctx.perf_coordinator.rebalance_service(
            service_name=service,
            strategy=strategy,
            initiator="cli",
        )
        click.echo(_format_output(result, ctx.json_out))

    ctx.loop.run_until_complete(_runner())


# ------------------------------------------------------------------------------
# Command: backup
# ------------------------------------------------------------------------------

@cli.command()
@click.option("--service", "-s", required=True, help="Target micro-service.")
@click.option("--label", "-l", default=None, help="Optional backup label.")
@click.pass_obj
def backup(ctx: CLIContext, service: str, label: Optional[str]) -> None:
    """
    Create an immediate backup for the micro-service state (DB, configs, etc.).
    """

    async def _runner() -> None:
        label_final = label or f"manual-{time.strftime('%Y%m%d-%H%M%S')}"
        logging.info("Creating backup [%s] for %s", label_final, service)
        result: JSON = await ctx.recovery_coordinator.create_backup(
            service_name=service,
            label=label_final,
        )
        click.echo(_format_output(result, ctx.json_out))

    ctx.loop.run_until_complete(_runner())


# ------------------------------------------------------------------------------
# Command: recover
# ------------------------------------------------------------------------------

@cli.command()
@click.option("--service", "-s", required=True, help="Target micro-service.")
@click.option(
    "--label",
    "-l",
    required=True,
    help="Backup label to restore (see `vo backup --list`).",
)
@click.pass_obj
def recover(ctx: CLIContext, service: str, label: str) -> None:
    """
    Restore a micro-service from a named backup.
    """

    async def _runner() -> None:
        logging.warning("Initiating recovery for %s from backup %s", service, label)
        stream = ctx.recovery_coordinator.recover(
            service_name=service,
            label=label,
        )
        await _stream_result(stream, as_json=ctx.json_out)

    ctx.loop.run_until_complete(_runner())


# ------------------------------------------------------------------------------
# Command: deploy
# ------------------------------------------------------------------------------

@cli.command()
@click.option("--service", "-s", required=True, help="Target micro-service.")
@click.option(
    "--strategy",
    "-st",
    default="rolling",
    type=click.Choice(["rolling", "blue-green", "canary"]),
    show_default=True,
)
@click.option(
    "--image",
    "-i",
    required=True,
    help="Container image reference (e.g., registry/my-svc:v1.2.3).",
)
@click.pass_obj
def deploy(ctx: CLIContext, service: str, strategy: str, image: str) -> None:
    """
    Trigger deployment automation for the given service.
    """

    async def _runner() -> None:
        logging.info("Deploying %s using strategy=%s image=%s", service, strategy, image)
        stream = ctx.deployment_coordinator.deploy(
            service_name=service,
            strategy=strategy,
            image=image,
        )
        await _stream_result(stream, as_json=ctx.json_out)

    ctx.loop.run_until_complete(_runner())


# ------------------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------------------

def _main() -> None:
    try:
        cli(standalone_mode=False)
    except click.ClickException as exc:
        # Already nicely formatted by Click, we just ensure non-zero exit code.
        logging.error("Fatal CLI error: %s", exc)
        sys.exit(exc.exit_code)
    except Exception as exc:  # pragma: no cover
        # Any uncaught exception bubbles up here. We log a * concise* summary,
        # then re-raise so that the correct traceback is printed.
        logging.exception("Unhandled exception: %s", exc)
        raise


if __name__ == "__main__":
    _main()
