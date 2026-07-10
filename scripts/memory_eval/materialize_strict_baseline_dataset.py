#!/usr/bin/env python3
"""Materialize nested prepared datasets from strict baseline-pass results."""

from __future__ import annotations

import argparse
import copy
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from locobench.memory_eval.io import copy_tree_clean, write_json, write_jsonl
from locobench.memory_eval.prepare import prepare_dataset
from select_baseline_post_run_cases import _normalize_workspace_markdown_fences


LANGUAGE_ORDER = ["c", "cpp", "python", "javascript", "typescript", "java", "php", "rust", "go", "csharp"]


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _passing_rows(paths: list[Path]) -> list[dict[str, Any]]:
    by_case: dict[str, dict[str, Any]] = {}
    for path in paths:
        for row in _read_jsonl(path):
            if row.get("baseline_status") != "passed" or row.get("environment_status") != "ready":
                continue
            case_id = str(row["case_id"])
            by_case.setdefault(case_id, row)
    order = {language: index for index, language in enumerate(LANGUAGE_ORDER)}
    return sorted(by_case.values(), key=lambda row: (order.get(str(row.get("language")), 999), str(row["case_id"])))


def _balanced_subset(rows: list[dict[str, Any]], size: int) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[str(row.get("language") or "unknown")].append(row)
    selected: list[dict[str, Any]] = []
    depth = 0
    while len(selected) < min(size, len(rows)):
        added = False
        for language in LANGUAGE_ORDER:
            items = groups.get(language, [])
            if depth < len(items):
                selected.append(items[depth])
                added = True
                if len(selected) >= min(size, len(rows)):
                    break
        if not added:
            break
        depth += 1
    return selected


def _test_plan(row: dict[str, Any], image_lock: dict[str, Any]) -> dict[str, Any]:
    plan = copy.deepcopy(row["test_plan"])
    language = str(row.get("language") or "")
    locked = image_lock[language]
    plan["docker_image"] = locked["tag"]
    plan["executor"] = "host"
    plan["source"] = f"strict_baseline:{plan.get('source') or 'resolved'}"
    environment = plan.get("environment") if isinstance(plan.get("environment"), dict) else {}
    plan["environment"] = {**environment, "recommended_executor": "docker", "network": "none"}
    return plan


def _wrapped_scenario(row: dict[str, Any]) -> dict[str, Any]:
    source = json.loads(Path(row["scenario_path"]).read_text(encoding="utf-8"))
    scenario_id = str(row["scenario_id"])
    wrapped = copy.deepcopy(source)
    wrapped["scenario_id"] = scenario_id
    wrapped["category"] = "extended_development_projects"
    wrapped["project_spec"] = {"language": str(row["language"])}
    wrapped["original_scenario"] = {
        "task_category": source.get("task_category", "multi_session_development"),
        "task_prompt": source.get("task_prompt") or source.get("description") or "",
    }
    return wrapped


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-results", action="append", required=True, type=Path)
    parser.add_argument("--inputs", required=True, type=Path)
    parser.add_argument("--prepared-small", required=True, type=Path)
    parser.add_argument("--prepared-all", required=True, type=Path)
    parser.add_argument("--small-size", type=int, default=10)
    parser.add_argument("--base-overlay", type=Path, default=ROOT / "configs/memory_contracts_v4.json")
    parser.add_argument("--image-lock", type=Path, default=ROOT / "docker/memory_eval/image_lock_20260709.json")
    args = parser.parse_args()

    rows = _passing_rows([path.resolve() for path in args.baseline_results])
    if len(rows) < args.small_size:
        raise SystemExit(f"Only {len(rows)} strict baseline passes; need at least {args.small_size}")
    if args.inputs.exists() or args.prepared_small.exists() or args.prepared_all.exists():
        raise FileExistsError("Refusing to overwrite an existing materialized dataset")

    image_lock = json.loads(args.image_lock.read_text(encoding="utf-8"))
    base_overlay = json.loads(args.base_overlay.read_text(encoding="utf-8"))
    generated_dir = args.inputs / "generated"
    scenarios_all = args.inputs / "scenarios_all"
    generated_dir.mkdir(parents=True)
    scenarios_all.mkdir(parents=True)

    normalization_rows: list[dict[str, Any]] = []
    for row in rows:
        case_id = str(row["case_id"])
        scenario_id = str(row["scenario_id"])
        destination = generated_dir / case_id
        copy_tree_clean(Path(row["project_source"]), destination)
        normalized = _normalize_workspace_markdown_fences(destination)
        write_json(scenarios_all / f"{scenario_id}.json", _wrapped_scenario(row))
        normalization_rows.append({"case_id": case_id, "normalized_file_count": len(normalized), "normalized_files": normalized})

    overlay = copy.deepcopy(base_overlay)
    overlay["case_test_plans"] = {str(row["case_id"]): _test_plan(row, image_lock) for row in rows}
    overlay_path = args.inputs / "strict_baseline_overlay.json"
    write_json(overlay_path, overlay)

    small = _balanced_subset(rows, args.small_size)
    write_jsonl(args.inputs / "selected_all.jsonl", rows)
    write_jsonl(args.inputs / "selected_10.jsonl", small)
    write_json(args.inputs / "normalization_report.json", {"cases": normalization_rows})
    write_json(
        args.inputs / "selection_manifest.json",
        {
            "strict_gate": {
                "session_count_min": 2,
                "baseline_status": "passed",
                "environment_status": "ready",
                "full_original_test_plan": True,
                "docker_network": "none",
                "test_file_fallback": False,
            },
            "small_count": len(small),
            "all_count": len(rows),
            "small_case_ids": [row["case_id"] for row in small],
            "all_case_ids": [row["case_id"] for row in rows],
            "image_lock": image_lock,
        },
    )

    small_scenarios = args.inputs / "scenarios_10"
    small_scenarios.mkdir()
    for row in small:
        name = f"{row['scenario_id']}.json"
        small_scenarios.joinpath(name).write_bytes(scenarios_all.joinpath(name).read_bytes())

    small_summary = prepare_dataset(
        scenarios_dir=small_scenarios,
        generated_dir=generated_dir,
        output_dir=args.prepared_small,
        category="extended_development_projects",
        contract_overlay=overlay_path,
    )
    all_summary = prepare_dataset(
        scenarios_dir=scenarios_all,
        generated_dir=generated_dir,
        output_dir=args.prepared_all,
        category="extended_development_projects",
        contract_overlay=overlay_path,
    )
    print(json.dumps({"small": small_summary["case_count"], "all": all_summary["case_count"]}, indent=2))


if __name__ == "__main__":
    main()
