#!/usr/bin/env python3
"""Score LoCoBench memory eval run outputs."""

import argparse
import shlex
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from locobench.memory_eval.scoring import score_runs


def _resolve_output_path(output: Path) -> Path:
    """Return the JSON report path, creating a timestamped folder when output is a directory."""
    if output.suffix == ".json":
        return output
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return output / timestamp / "score_report.json"


def main() -> None:
    parser = argparse.ArgumentParser(description="Score memory eval runs")
    parser.add_argument("--runs", required=True, nargs="+", type=Path)
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help=(
            "JSON report path or report root directory. If a directory is provided, "
            "a timestamped subdirectory containing score_report.json, score_report.md, "
            "and readable_report.md is created."
        ),
    )
    parser.add_argument("--prepared", default=None, type=Path, help="Optional evaluator-only prepared dataset root")
    parser.add_argument("--no-llm-judge", action="store_true", help="Disable default command-backed pairwise LLM judging")
    parser.add_argument(
        "--judge-command",
        default="codeagentcli --dangerously-skip-permissions -p --output-format stream-json --verbose",
        help="Command used for default pairwise LLM judging",
    )
    parser.add_argument("--judge-timeout-sec", type=int, default=300, help="Timeout per judged pairwise case")
    parser.add_argument("--judge-max-chars", type=int, default=12000, help="Maximum judge prompt characters")
    parser.add_argument(
        "--allow-unverified-provenance",
        action="store_true",
        help="Compatibility escape hatch for legacy runs without embedded prepared snapshots",
    )
    args = parser.parse_args()

    llm_judge = None
    if not args.no_llm_judge:
        llm_judge = {
            "enabled": True,
            "command": shlex.split(args.judge_command),
            "timeout_sec": args.judge_timeout_sec,
            "max_chars": args.judge_max_chars,
        }

    output = _resolve_output_path(args.output)
    report = score_runs(
        args.runs,
        output,
        prepared_dir=args.prepared,
        llm_judge=llm_judge,
        progress=print,
        strict_provenance=not args.allow_unverified_provenance,
    )
    print(f"Wrote report for {len(report['variants'])} variants to {output}")
    print(f"Wrote readable report to {output.parent / 'readable_report.md'}")


if __name__ == "__main__":
    main()
