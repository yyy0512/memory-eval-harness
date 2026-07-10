#!/usr/bin/env python3
"""Build a Go memory-eval Docker image with prepared dataset module cache."""

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from locobench.memory_eval.io import read_json, write_json
from locobench.memory_eval.runner import load_manifest


def _safe_name(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("_")
    return text[:80] or "module"


def _case_scoring_reference(prepared: Path, scenario_id: str) -> dict[str, Any]:
    path = prepared / "cases" / scenario_id / "scoring_reference.json"
    return read_json(path) if path.exists() else {}


def collect_modules(prepared_dirs: list[Path]) -> list[dict[str, Any]]:
    modules: list[dict[str, Any]] = []
    seen: set[str] = set()
    for prepared in prepared_dirs:
        for case in load_manifest(prepared):
            scenario_id = str(case.get("scenario_id") or "")
            case_id = str(case.get("case_id") or scenario_id)
            reference = _case_scoring_reference(prepared, scenario_id)
            test_plan = reference.get("test_plan") if isinstance(reference, dict) else {}
            working_dir = str(test_plan.get("working_dir") or ".") if isinstance(test_plan, dict) else "."
            project_source = Path(str(case.get("project_source") or ""))
            candidates = []
            primary = project_source / working_dir / "go.mod"
            if primary.is_file():
                candidates.append(primary)
            for path in sorted(project_source.rglob("go.mod")):
                if path.is_file() and path not in candidates:
                    candidates.append(path)
            for go_mod in candidates:
                key = str(go_mod.resolve())
                if key in seen:
                    continue
                seen.add(key)
                modules.append(
                    {
                        "case_id": case_id,
                        "scenario_id": scenario_id,
                        "prepared": str(prepared),
                        "source_dir": str(go_mod.parent),
                        "go_mod": str(go_mod),
                        "go_sum": str(go_mod.with_name("go.sum")) if go_mod.with_name("go.sum").exists() else None,
                    }
                )
    return modules


def build_context(modules: list[dict[str, Any]], context: Path, base_image: str) -> None:
    if context.exists():
        raise FileExistsError(f"Build context already exists: {context}")
    modules_dir = context / "modules"
    modules_dir.mkdir(parents=True)
    docker_lines = [
        f"FROM {base_image}",
        "COPY modules/ /tmp/go-mods/",
        "RUN set -eu; \\",
    ]
    manifest_rows = []
    for index, module in enumerate(modules, start=1):
        name = f"m{index:04d}_{_safe_name(module['case_id'])}"
        dst = modules_dir / name
        dst.mkdir()
        shutil.copy2(module["go_mod"], dst / "go.mod")
        if module.get("go_sum"):
            shutil.copy2(module["go_sum"], dst / "go.sum")
        manifest_row = {**module, "context_module_dir": f"modules/{name}"}
        manifest_rows.append(manifest_row)
        suffix = " && \\" if index < len(modules) else ""
        docker_lines.append(f"    (cd /tmp/go-mods/{name} && go mod download) || true{suffix}")
    if not modules:
        docker_lines.append("    true")
    (context / "Dockerfile").write_text("\n".join(docker_lines) + "\n", encoding="utf-8")
    write_json(context / "module_manifest.json", {"base_image": base_image, "module_count": len(modules), "modules": manifest_rows})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared", required=True, nargs="+", type=Path)
    parser.add_argument("--output-context", required=True, type=Path)
    parser.add_argument("--base-image", default="locobench-memory-eval:go")
    parser.add_argument("--tag", required=True)
    parser.add_argument("--build", action="store_true")
    args = parser.parse_args()

    prepared_dirs = [path.resolve() for path in args.prepared]
    context = args.output_context.resolve()
    modules = collect_modules(prepared_dirs)
    build_context(modules, context, args.base_image)
    print(f"Collected {len(modules)} Go modules into {context}", flush=True)
    print(f"Dockerfile: {context / 'Dockerfile'}", flush=True)
    if args.build:
        command = ["docker", "build", "-t", args.tag, str(context)]
        print("Running:", " ".join(command), flush=True)
        completed = subprocess.run(command, check=False)
        if completed.returncode:
            raise SystemExit(completed.returncode)


if __name__ == "__main__":
    main()
