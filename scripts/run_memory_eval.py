#!/usr/bin/env python3
"""Run prepared LoCoBench memory eval cases with Code Agent CLI."""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from locobench.memory_eval.runner import run_batch


def main() -> None:
    parser = argparse.ArgumentParser(description="Run LoCoBench memory eval cases")
    parser.add_argument("--prepared", required=True, type=Path)
    parser.add_argument("--agent-bin", default="codeagentcli")
    parser.add_argument("--memory-mode", choices=["on", "off", "bare"], required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout-sec", type=int, default=1800)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--scenario-id", default=None)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()

    summary = run_batch(
        prepared_dir=args.prepared,
        agent_bin=args.agent_bin,
        memory_mode=args.memory_mode,
        output_dir=args.output,
        timeout_sec=args.timeout_sec,
        limit=args.limit,
        scenario_id=args.scenario_id,
        resume=args.resume,
        progress=lambda message: print(message, flush=True),
    )
    print(
        f"Run complete: {summary['completed_cases']}/{summary['case_count']} completed "
        f"for memory_mode={summary['memory_mode']}"
    )
    if summary.get("failed_cases", 0):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
