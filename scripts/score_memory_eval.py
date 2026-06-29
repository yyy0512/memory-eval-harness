#!/usr/bin/env python3
"""Score LoCoBench memory eval run outputs."""

import argparse
import shlex
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from locobench.memory_eval.scoring import score_runs


def main() -> None:
    parser = argparse.ArgumentParser(description="Score memory eval runs")
    parser.add_argument("--runs", required=True, nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--prepared", default=None, type=Path, help="Optional evaluator-only prepared dataset root")
    parser.add_argument("--llm-judge", action="store_true", help="Enable optional command-backed LLM judging")
    parser.add_argument(
        "--judge-command",
        default="codeagentcli --dangerously-skip-permissions -p --output-format stream-json --verbose",
        help="Command used for LLM judging when --llm-judge is set",
    )
    parser.add_argument("--judge-timeout-sec", type=int, default=300, help="Timeout per judged case")
    parser.add_argument("--judge-max-chars", type=int, default=12000, help="Maximum judge prompt characters")
    args = parser.parse_args()

    llm_judge = None
    if args.llm_judge:
        llm_judge = {
            "enabled": True,
            "command": shlex.split(args.judge_command),
            "timeout_sec": args.judge_timeout_sec,
            "max_chars": args.judge_max_chars,
        }

    report = score_runs(args.runs, args.output, prepared_dir=args.prepared, llm_judge=llm_judge, progress=print)
    print(f"Wrote report for {len(report['variants'])} variants to {args.output}")


if __name__ == "__main__":
    main()
