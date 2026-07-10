#!/usr/bin/env python3
"""Run one memory eval case/session as a Code Agent CLI smoke test."""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from locobench.memory_eval.runner import run_smoke


def main() -> None:
    parser = argparse.ArgumentParser(description="Smoke test Code Agent CLI memory eval connectivity")
    parser.add_argument("--prepared", required=True, type=Path)
    parser.add_argument("--agent-bin", default="codeagentcli")
    parser.add_argument("--scenario-id", default=None)
    parser.add_argument("--session", type=int, default=1)
    parser.add_argument(
        "--memory-mode",
        choices=[
            "on",
            "off",
            "memory_on",
            "memory_off",
            "native",
            "native_memory_on",
            "openviking",
            "openviking_on",
            "bare",
        ],
        default="on",
    )
    parser.add_argument("--plugin-dir", type=Path, default=None, help="CodeAgent OpenViking plugin directory for OpenViking modes")
    parser.add_argument("--openviking-url", default="http://127.0.0.1:1933")
    parser.add_argument("--openviking-account", default="memory-eval")
    parser.add_argument("--openviking-user-prefix", default=None)
    parser.add_argument("--openviking-peer-prefix", default=None)
    parser.add_argument("--run-namespace", default=None)
    parser.add_argument("--openviking-debug", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout-sec", type=int, default=1800)
    args = parser.parse_args()

    summary = run_smoke(
        prepared_dir=args.prepared,
        agent_bin=args.agent_bin,
        scenario_id=args.scenario_id,
        session=args.session,
        memory_mode=args.memory_mode,
        output_dir=args.output,
        timeout_sec=args.timeout_sec,
        plugin_dir=args.plugin_dir,
        openviking_url=args.openviking_url,
        openviking_account=args.openviking_account,
        openviking_user_prefix=args.openviking_user_prefix,
        openviking_peer_prefix=args.openviking_peer_prefix,
        openviking_debug=args.openviking_debug,
        run_namespace=args.run_namespace,
    )
    print(f"Smoke status: {summary['status']} ({summary['scenario_id']} session {summary['session']})")
    if summary["status"] != "pass":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
