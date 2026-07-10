#!/usr/bin/env python3
"""Validate prepared baseline post-run tests without running agent sessions."""

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from locobench.memory_eval.io import write_json
from locobench.memory_eval.runner import load_manifest, run_post_run_tests, setup_workspace_at


def _case_key(case: dict[str, Any]) -> str:
    return str(case.get("case_id") or case.get("scenario_id") or "case")


def _should_keep(test_result: dict[str, Any]) -> bool:
    status = str(test_result.get("status") or "")
    environment_status = str(test_result.get("environment_status") or "")
    integrity_status = str(test_result.get("integrity_status") or "not_checked")
    if status == "passed":
        return True
    return status == "failed" and environment_status == "ready" and integrity_status != "failed"


def _drop_reason(test_result: dict[str, Any]) -> str | None:
    if _should_keep(test_result):
        return None
    status = str(test_result.get("status") or "unknown")
    reason = test_result.get("reason") or test_result.get("failure_classification")
    environment_status = test_result.get("environment_status")
    integrity_status = test_result.get("integrity_status")
    details = [f"status={status}"]
    if environment_status:
        details.append(f"environment={environment_status}")
    if integrity_status:
        details.append(f"integrity={integrity_status}")
    if reason:
        details.append(f"reason={reason}")
    return ", ".join(details)


def _summarize_case(case: dict[str, Any], test_result: dict[str, Any]) -> dict[str, Any]:
    keep = _should_keep(test_result)
    return {
        "scenario_id": case.get("scenario_id"),
        "case_id": case.get("case_id"),
        "language": case.get("language"),
        "session_count": case.get("session_count"),
        "keep": keep,
        "drop_reason": None if keep else _drop_reason(test_result),
        "status": test_result.get("status"),
        "environment_status": test_result.get("environment_status"),
        "integrity_status": test_result.get("integrity_status"),
        "failure_classification": test_result.get("failure_classification"),
        "missing_dependency": test_result.get("missing_dependency"),
        "reason": test_result.get("reason"),
        "source": test_result.get("source"),
        "command": test_result.get("command") or [],
        "working_dir": test_result.get("working_dir"),
        "exit_code": test_result.get("exit_code"),
        "duration_sec": test_result.get("duration_sec"),
    }


def _distribution(items: list[dict[str, Any]], key: str) -> dict[str, int]:
    return dict(sorted(Counter(str(item.get(key) or "unknown") for item in items).items()))


def _write_readable_report(output: Path, prepared: Path, rows: list[dict[str, Any]], summary: dict[str, Any]) -> None:
    lines = [
        "# Prepared post-run validation",
        "",
        f"Prepared dataset: `{prepared}`",
        f"Case count: {summary['case_count']}",
        f"Kept: {summary['kept_count']}",
        f"Dropped: {summary['dropped_count']}",
        "",
        "## Status distribution",
        "",
        "| Field | Distribution |",
        "| --- | --- |",
        f"| status | `{json.dumps(summary['status_distribution'], ensure_ascii=False)}` |",
        f"| environment | `{json.dumps(summary['environment_distribution'], ensure_ascii=False)}` |",
        f"| integrity | `{json.dumps(summary['integrity_distribution'], ensure_ascii=False)}` |",
        f"| failure | `{json.dumps(summary['failure_distribution'], ensure_ascii=False)}` |",
        "",
        "## Cases",
        "",
        "| keep | case_id | status | environment | integrity | failure | reason |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for row in rows:
        reason = row.get("drop_reason") or row.get("reason") or ""
        lines.append(
            f"| {'yes' if row['keep'] else 'no'} | `{row.get('case_id')}` | `{row.get('status')}` | "
            f"`{row.get('environment_status')}` | `{row.get('integrity_status')}` | "
            f"`{row.get('failure_classification')}` | {reason} |"
        )
    output.joinpath("readable_report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def validate_prepared(
    prepared: Path,
    output: Path,
    test_executor: str | None,
    docker_image: str | None,
    docker_network: str,
    limit: int | None = None,
    scenario_ids: set[str] | None = None,
) -> dict[str, Any]:
    cases = load_manifest(prepared)
    if scenario_ids:
        cases = [case for case in cases if str(case.get("scenario_id") or "") in scenario_ids or str(case.get("case_id") or "") in scenario_ids]
    if limit is not None:
        cases = cases[:limit]

    rows: list[dict[str, Any]] = []
    session_ok = SimpleNamespace(is_error=False)
    for index, case in enumerate(cases, start=1):
        case_root = output / _case_key(case)
        paths = setup_workspace_at(case, case_root)
        test_result = run_post_run_tests(
            prepared,
            case,
            paths,
            [session_ok],
            test_executor=test_executor,
            docker_image=docker_image,
            docker_network=docker_network,
        )
        row = _summarize_case(case, test_result)
        row["index"] = index
        rows.append(row)
        print(
            f"[{index}/{len(cases)}] {row['case_id']}: status={row['status']} "
            f"env={row['environment_status']} keep={row['keep']}",
            flush=True,
        )

    kept = [row for row in rows if row["keep"]]
    dropped = [row for row in rows if not row["keep"]]
    summary = {
        "prepared": str(prepared),
        "output": str(output),
        "case_count": len(rows),
        "kept_count": len(kept),
        "dropped_count": len(dropped),
        "test_executor": test_executor,
        "docker_image": docker_image if test_executor == "docker" else None,
        "docker_network": docker_network if test_executor == "docker" else None,
        "status_distribution": _distribution(rows, "status"),
        "environment_distribution": _distribution(rows, "environment_status"),
        "integrity_distribution": _distribution(rows, "integrity_status"),
        "failure_distribution": _distribution(rows, "failure_classification"),
        "kept_cases": kept,
        "dropped_cases": dropped,
    }
    write_json(output / "validation_summary.json", summary)
    write_json(output / "keep_cases.json", {"cases": kept})
    write_json(output / "drop_cases.json", {"cases": dropped})
    _write_readable_report(output, prepared, rows, summary)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--test-executor", choices=["host", "docker"], default=None)
    parser.add_argument("--docker-image", default=None)
    parser.add_argument("--docker-network", default="none")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--scenario-id", action="append", default=[])
    args = parser.parse_args()

    summary = validate_prepared(
        prepared=args.prepared.resolve(),
        output=args.output.resolve(),
        test_executor=args.test_executor,
        docker_image=args.docker_image,
        docker_network=args.docker_network,
        limit=args.limit,
        scenario_ids=set(args.scenario_id) if args.scenario_id else None,
    )
    print(
        f"Validation complete: kept={summary['kept_count']} dropped={summary['dropped_count']} total={summary['case_count']}",
        flush=True,
    )


if __name__ == "__main__":
    main()
