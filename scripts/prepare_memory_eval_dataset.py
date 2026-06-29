#!/usr/bin/env python3
"""Prepare LoCoBench-Agent scenarios for memory evaluation."""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from locobench.memory_eval.prepare import prepare_dataset


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare a LoCoBench memory eval dataset")
    parser.add_argument("--scenarios", required=True, type=Path)
    parser.add_argument("--generated", required=True, type=Path)
    parser.add_argument("--category", default="extended_development_projects")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    summary = prepare_dataset(
        scenarios_dir=args.scenarios,
        generated_dir=args.generated,
        output_dir=args.output,
        category=args.category,
        limit=args.limit,
    )
    print(f"Prepared {summary['case_count']} memory eval cases at {args.output}")


if __name__ == "__main__":
    main()
