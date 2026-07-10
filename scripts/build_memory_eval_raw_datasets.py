#!/usr/bin/env python3
"""Build fixed raw memory-eval dataset subsets from the full LoCoBench data pool."""

import argparse
import json
import shutil
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from locobench.memory_eval.prepare import extract_case_id, is_memory_eval_scenario, split_prompt_into_sessions


DEFAULT_SPLITS = (("v1", 1), ("v2", 10), ("v3", 100))


def _read_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, value: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _copy_tree(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def _scenario_session_count(data: Dict[str, Any]) -> int:
    original = data.get("original_scenario") or {}
    task_prompt = original.get("task_prompt") or data.get("description") or ""
    return len(split_prompt_into_sessions(task_prompt))


def _eligible_scenarios(scenarios_dir: Path, category: str, min_sessions: int) -> List[Dict[str, Any]]:
    selected: List[Dict[str, Any]] = []
    for scenario_file in sorted(scenarios_dir.glob("*multi_session_development*.json")):
        data = _read_json(scenario_file)
        if not is_memory_eval_scenario(data, category):
            continue
        session_count = _scenario_session_count(data)
        if session_count < min_sessions:
            continue
        scenario_id = str(data.get("scenario_id") or data.get("id") or scenario_file.stem)
        selected.append(
            {
                "scenario_id": scenario_id,
                "case_id": extract_case_id(scenario_id),
                "scenario_file": scenario_file,
                "session_count": session_count,
                "difficulty": data.get("difficulty") or (data.get("original_scenario") or {}).get("difficulty") or "unknown",
                "language": ((data.get("project_spec") or {}).get("language") or "unknown"),
            }
        )
    return selected


def _copy_case_dataset(source_root: Path, output_root: Path, rows: List[Dict[str, Any]], min_sessions: int, category: str) -> None:
    if output_root.exists():
        shutil.rmtree(output_root)

    output_agent_scenarios = output_root / "output" / "agent_scenarios"
    output_scenarios = output_root / "output" / "scenarios"
    output_test_suites = output_root / "output" / "validation" / "test_suites"
    output_generated = output_root / "generated"
    output_agent_scenarios.mkdir(parents=True, exist_ok=True)
    output_scenarios.mkdir(parents=True, exist_ok=True)
    output_test_suites.mkdir(parents=True, exist_ok=True)
    output_generated.mkdir(parents=True, exist_ok=True)

    copied_cases = []
    for row in rows:
        scenario_id = row["scenario_id"]
        case_id = row["case_id"]
        scenario_file = row["scenario_file"]
        shutil.copy2(scenario_file, output_agent_scenarios / scenario_file.name)
        source_scenario_file = source_root / "output" / "scenarios" / scenario_file.name
        if source_scenario_file.exists():
            shutil.copy2(source_scenario_file, output_scenarios / source_scenario_file.name)
        validation_file = source_root / "output" / "validation" / "test_suites" / f"{scenario_id}_tests.json"
        if validation_file.exists():
            shutil.copy2(validation_file, output_test_suites / validation_file.name)
        generated_source = source_root / "generated" / case_id
        if not generated_source.exists():
            raise FileNotFoundError(f"Generated project not found for {scenario_id}: {generated_source}")
        _copy_tree(generated_source, output_generated / case_id)
        copied_cases.append({key: row[key] for key in ("scenario_id", "case_id", "session_count", "difficulty", "language")})

    session_counts = Counter(str(row["session_count"]) for row in copied_cases)
    difficulties = Counter(str(row["difficulty"] or "unknown") for row in copied_cases)
    languages = Counter(str(row["language"] or "unknown") for row in copied_cases)
    manifest = {
        "case_count": len(copied_cases),
        "category": category,
        "min_sessions": min_sessions,
        "source_root": str(source_root.resolve()),
        "selection_order": "sorted output/agent_scenarios/*multi_session_development*.json, filtered by session_count >= min_sessions, first N",
        "session_count_distribution": dict(sorted(session_counts.items())),
        "difficulty_distribution": dict(sorted(difficulties.items())),
        "programming_language_distribution": dict(sorted(languages.items())),
        "cases": copied_cases,
    }
    _write_json(output_root / "dataset_manifest.json", manifest)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build fixed raw memory-eval v1/v2/v3 dataset subsets")
    parser.add_argument("--source-root", type=Path, default=ROOT / "data")
    parser.add_argument("--category", default="extended_development_projects")
    parser.add_argument("--min-sessions", type=int, default=2)
    parser.add_argument("--v1-limit", type=int, default=1)
    parser.add_argument("--v2-limit", type=int, default=10)
    parser.add_argument("--v3-limit", type=int, default=100)
    parser.add_argument("--output-prefix", default="memory_eval")
    args = parser.parse_args()

    source_root = args.source_root.resolve()
    scenarios_dir = source_root / "output" / "agent_scenarios"
    rows = _eligible_scenarios(scenarios_dir, args.category, args.min_sessions)
    splits = (("v1", args.v1_limit), ("v2", args.v2_limit), ("v3", args.v3_limit))
    max_limit = max(limit for _, limit in splits)
    if len(rows) < max_limit:
        raise ValueError(f"Only {len(rows)} eligible scenarios found; need {max_limit}")

    for version, limit in splits:
        output_root = ROOT / f"{args.output_prefix}_{version}_data"
        _copy_case_dataset(source_root, output_root, rows[:limit], args.min_sessions, args.category)
        print(f"Wrote {limit} cases to {output_root}")


if __name__ == "__main__":
    main()
