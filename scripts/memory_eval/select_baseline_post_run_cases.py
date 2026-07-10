#!/usr/bin/env python3
"""Select LoCoBench cases whose original post-run tests pass in Docker."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from locobench.memory_eval.io import copy_tree_clean, write_json, write_jsonl
from locobench.memory_eval.prepare import extract_case_id, split_prompt_into_sessions, _resolve_test_plan
from locobench.memory_eval.runner import _classify_test_failure, _docker_command


NORMALIZE_EXTENSIONS = {
    ".c",
    ".cc",
    ".cfg",
    ".conf",
    ".cpp",
    ".cs",
    ".csproj",
    ".cxx",
    ".gradle",
    ".go",
    ".h",
    ".hpp",
    ".ini",
    ".java",
    ".js",
    ".jsx",
    ".json",
    ".kt",
    ".mjs",
    ".php",
    ".properties",
    ".py",
    ".rs",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}

NORMALIZE_FILENAMES = {
    "cmakelists.txt",
    "dockerfile",
    "makefile",
}


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _scenario_id(data: dict[str, Any], path: Path) -> str:
    return str(data.get("id") or data.get("scenario_id") or path.stem)


def _task_prompt(data: dict[str, Any]) -> Any:
    original = data.get("original_scenario") if isinstance(data.get("original_scenario"), dict) else {}
    return data.get("task_prompt") or original.get("task_prompt") or data.get("description") or ""


def _candidate_scenarios(
    scenarios_dir: Path,
    generated_dir: Path,
    languages: list[str],
    normalize_markdown_fences: bool = False,
) -> list[dict[str, Any]]:
    language_order = {language: index for index, language in enumerate(languages)}
    candidates: list[dict[str, Any]] = []
    for scenario_path in sorted(scenarios_dir.glob("*multi_session_development*.json")):
        data = _read_json(scenario_path)
        scenario_id = _scenario_id(data, scenario_path)
        case_id = extract_case_id(scenario_id)
        language = case_id.split("_", 1)[0]
        if language not in language_order:
            continue
        sessions = split_prompt_into_sessions(_task_prompt(data))
        if len(sessions) <= 1:
            continue
        project_source = generated_dir / case_id
        if not project_source.exists():
            continue
        test_plan = _resolve_test_plan(project_source, language, {}, case_id, scenario_id)
        if normalize_markdown_fences and test_plan.get("status") != "configured":
            with tempfile.TemporaryDirectory(prefix=f"memory-eval-discovery-{case_id}-") as temporary:
                normalized_source = Path(temporary) / "project"
                copy_tree_clean(project_source, normalized_source)
                normalized_files = _normalize_workspace_markdown_fences(normalized_source)
                normalized_plan = _resolve_test_plan(normalized_source, language, {}, case_id, scenario_id)
                if normalized_plan.get("status") == "configured":
                    normalized_plan["source"] = f"normalized_discovery:{normalized_plan.get('source') or 'resolved'}"
                    normalized_plan["normalized_discovery_files"] = normalized_files[:200]
                    test_plan = normalized_plan
        candidates.append(
            {
                "scenario_id": scenario_id,
                "case_id": case_id,
                "language": language,
                "session_count": len(sessions),
                "scenario_path": str(scenario_path),
                "project_source": str(project_source),
                "test_plan": test_plan,
            }
        )
    candidates.sort(key=lambda item: (language_order[item["language"]], item["case_id"], item["scenario_id"]))
    return candidates


def _docker_image_for(language: str, image_overrides: dict[str, str]) -> str:
    defaults = {
        "python": "locobench-memory-eval:python",
        "javascript": "locobench-memory-eval:javascript",
        "typescript": "locobench-memory-eval:javascript",
        "go": "locobench-memory-eval:go",
        "rust": "locobench-memory-eval:rust",
    }
    return image_overrides.get(language) or defaults.get(language) or f"locobench-memory-eval:{language}"


def _unwrap_markdown_fence(text: str) -> str | None:
    leading_len = len(text) - len(text.lstrip())
    leading = text[:leading_len]
    stripped = text[leading_len:]
    lines = stripped.splitlines(keepends=True)
    if not lines:
        return None

    opener = lines[0].strip()
    if re.fullmatch(r"```[A-Za-z0-9_+.-]*", opener):
        closer = "```"
    elif re.fullmatch(r"'''[A-Za-z][A-Za-z0-9_+.-]*", opener):
        # Some generated source/test files use Python-style triple quotes as
        # a pseudo-Markdown fence, for example: '''python.  Requiring a
        # language suffix avoids unwrapping a legitimate module docstring.
        closer = "'''"
    elif re.fullmatch(r'"""[A-Za-z][A-Za-z0-9_+.-]*', opener):
        closer = '"""'
    else:
        return None

    end_index = None
    for index in range(len(lines) - 1, 0, -1):
        if lines[index].strip() == closer:
            end_index = index
            break
    if end_index is None:
        # A lone, language-tagged fence opener is also a common generator
        # artifact.  In the source/config formats routed through this helper it
        # is never valid program text, so removing only that header is a
        # syntax-only repair.
        return leading + "".join(lines[1:])

    body = "".join(lines[1:end_index])
    trailing = "".join(lines[end_index + 1 :])
    if trailing.strip():
        return None
    return leading + body


def _sanitize_xml_comments(text: str) -> str:
    """Repair syntax-only XML issues without changing element structure."""

    def replace_comment(match: re.Match[str]) -> str:
        body = match.group(1)
        while "--" in body:
            body = body.replace("--", "- -")
        return f"<!--{body}-->"

    text = re.sub(r"<!--(.*?)-->", replace_comment, text, flags=re.DOTALL)
    return re.sub(r"&(?!#\d+;|#x[0-9A-Fa-f]+;|amp;|lt;|gt;|apos;|quot;)", "&amp;", text)


def _resolve_maven_parent_version_property(text: str) -> str:
    """Resolve a Maven parent version property from this POM's properties."""

    def replace_parent(match: re.Match[str]) -> str:
        parent = match.group(0)
        version_match = re.search(r"<version>\s*\$\{([A-Za-z0-9_.-]+)\}\s*</version>", parent)
        if version_match is None:
            return parent
        key = version_match.group(1)
        value_match = re.search(rf"<{re.escape(key)}>\s*([^<]+?)\s*</{re.escape(key)}>", text)
        if value_match is None:
            return parent
        value = value_match.group(1).strip()
        return parent[: version_match.start()] + f"<version>{value}</version>" + parent[version_match.end() :]

    return re.sub(r"<parent>.*?</parent>", replace_parent, text, flags=re.DOTALL)


def _normalize_workspace_markdown_fences(workspace: Path) -> list[str]:
    normalized: list[str] = []
    for path in sorted(item for item in workspace.rglob("*") if item.is_file()):
        if path.suffix.lower() not in NORMALIZE_EXTENSIONS and path.name.lower() not in NORMALIZE_FILENAMES:
            continue
        try:
            original = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        normalized_text = _unwrap_markdown_fence(original) or original
        if path.suffix.lower() == ".xml":
            normalized_text = _sanitize_xml_comments(normalized_text)
            if path.name.lower() == "pom.xml":
                normalized_text = _resolve_maven_parent_version_property(normalized_text)
        if normalized_text == original:
            continue
        path.write_text(normalized_text, encoding="utf-8")
        normalized.append(path.relative_to(workspace).as_posix())
    return normalized


def _run_case(
    candidate: dict[str, Any],
    output_dir: Path,
    image_overrides: dict[str, str],
    docker_network: str,
    timeout_sec: int,
    normalize_markdown_fences: bool,
    dependency_cache_root: Path | None = None,
    bootstrap_node_globals: bool = False,
    bootstrap_php_tools: bool = False,
) -> dict[str, Any]:
    candidate = dict(candidate)
    test_plan = dict(candidate["test_plan"])
    case_id = candidate["case_id"]
    case_dir = output_dir / "cases" / case_id
    logs_dir = case_dir / "logs"
    workspace = case_dir / "workspace"
    logs_dir.mkdir(parents=True, exist_ok=True)

    if test_plan.get("status") != "configured" or not test_plan.get("command"):
        return {
            **candidate,
            "baseline_status": "skipped",
            "environment_status": "not_configured",
            "failure_classification": None,
            "reason": test_plan.get("reason") or "test plan is not configured",
            "exit_code": None,
        }

    copy_tree_clean(Path(candidate["project_source"]), workspace)
    normalized_files = _normalize_workspace_markdown_fences(workspace) if normalize_markdown_fences else []
    if bootstrap_node_globals and test_plan.get("command") == ["npm", "test"]:
        working_dir = workspace / str(test_plan.get("working_dir") or ".")
        package_type = ""
        try:
            package = json.loads((working_dir / "package.json").read_text(encoding="utf-8"))
            package_type = str(package.get("type") or "") if isinstance(package, dict) else ""
        except (OSError, json.JSONDecodeError):
            pass
        node_options = "export NODE_OPTIONS=--experimental-vm-modules; " if package_type == "module" else ""
        shell = f"ln -s /usr/local/lib/node_modules node_modules 2>/dev/null || true; {node_options}exec npm test"
        test_plan["command"] = ["sh", "-lc", shell]
        test_plan["source"] = f"environment_bootstrap:{test_plan.get('source') or 'package_json_test_script'}"
        candidate["test_plan"] = test_plan
    if bootstrap_php_tools and test_plan.get("command") == ["composer", "run", "test", "--no-interaction"]:
        shell = (
            "mkdir -p vendor/bin; "
            "ln -sf \"$(command -v phpunit)\" vendor/bin/phpunit; "
            "composer dump-autoload --no-interaction >/dev/null 2>&1 || true; "
            "exec composer run test --no-interaction"
        )
        test_plan["command"] = ["sh", "-lc", shell]
        test_plan["source"] = f"environment_bootstrap:{test_plan.get('source') or 'composer_test_script'}"
        candidate["test_plan"] = test_plan
    image = _docker_image_for(candidate["language"], image_overrides)
    command = [str(item) for item in test_plan["command"]]
    container_command = ["timeout", "--signal=KILL", f"{timeout_sec}s", *command]
    run_command = _docker_command(
        workspace,
        str(test_plan.get("working_dir") or "."),
        container_command,
        image,
        docker_network,
    )
    cache_mounts = {
        "java": "/root/.m2",
        "rust": "/root/.cargo",
        "go": "/root/go",
        "python": "/root/.cache/pip",
        "javascript": "/root/.npm",
        "typescript": "/root/.npm",
        "php": "/root/.cache/composer",
    }
    cache_target = cache_mounts.get(str(candidate["language"]))
    if dependency_cache_root is not None and cache_target:
        cache_source = dependency_cache_root / str(candidate["language"])
        cache_source.mkdir(parents=True, exist_ok=True)
        image_index = run_command.index(image)
        run_command[image_index:image_index] = ["-v", f"{cache_source.resolve()}:{cache_target}"]
    stdout_path = logs_dir / "baseline.stdout"
    stderr_path = logs_dir / "baseline.stderr"
    start = time.time()
    try:
        completed = subprocess.run(
            run_command,
            cwd=workspace,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_sec + 30,
            check=False,
        )
        stdout_path.write_text(completed.stdout, encoding="utf-8", errors="replace")
        stderr_path.write_text(completed.stderr, encoding="utf-8", errors="replace")
        elapsed_sec = time.time() - start
        if completed.returncode == 124 or (completed.returncode == 137 and elapsed_sec >= timeout_sec):
            return {
                **candidate,
                "normalization": {
                    "markdown_fence_unwrapped": normalize_markdown_fences,
                    "normalized_file_count": len(normalized_files),
                    "normalized_files": normalized_files[:200],
                },
                "baseline_status": "failed",
                "environment_status": "timeout",
                "failure_classification": "timeout",
                "missing_dependency": None,
                "reason": f"test command timed out after {timeout_sec}s",
                "exit_code": completed.returncode,
                "duration_sec": round(elapsed_sec, 3),
                "docker_image": image,
                "docker_network": docker_network,
                "stdout": str(stdout_path.relative_to(output_dir)),
                "stderr": str(stderr_path.relative_to(output_dir)),
            }
        classification = _classify_test_failure(completed.stdout, completed.stderr, completed.returncode, "docker")
        environment_status = classification["environment_status"]
        baseline_status = "passed" if completed.returncode == 0 and environment_status == "ready" else "failed"
        if environment_status != "ready":
            baseline_status = "skipped"
        return {
            **candidate,
            "normalization": {
                "markdown_fence_unwrapped": normalize_markdown_fences,
                "normalized_file_count": len(normalized_files),
                "normalized_files": normalized_files[:200],
            },
            "baseline_status": baseline_status,
            "environment_status": environment_status,
            "failure_classification": classification.get("failure_classification"),
            "missing_dependency": classification.get("missing_dependency"),
            "reason": classification.get("failure_classification"),
            "exit_code": completed.returncode,
            "duration_sec": round(time.time() - start, 3),
            "docker_image": image,
            "docker_network": docker_network,
            "stdout": str(stdout_path.relative_to(output_dir)),
            "stderr": str(stderr_path.relative_to(output_dir)),
        }
    except subprocess.TimeoutExpired as exc:
        stdout_text = exc.stdout.decode("utf-8", errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr_text = exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        stdout_path.write_text(stdout_text, encoding="utf-8", errors="replace")
        stderr_path.write_text(stderr_text, encoding="utf-8", errors="replace")
        return {
            **candidate,
            "normalization": {
                "markdown_fence_unwrapped": normalize_markdown_fences,
                "normalized_file_count": len(normalized_files),
                "normalized_files": normalized_files[:200],
            },
            "baseline_status": "timeout",
            "environment_status": "timeout",
            "failure_classification": "timeout",
            "missing_dependency": None,
            "reason": f"test command timed out after {timeout_sec}s",
            "exit_code": None,
            "duration_sec": round(time.time() - start, 3),
            "docker_image": image,
            "docker_network": docker_network,
            "stdout": str(stdout_path.relative_to(output_dir)),
            "stderr": str(stderr_path.relative_to(output_dir)),
        }
    except OSError as exc:
        return {
            **candidate,
            "normalization": {
                "markdown_fence_unwrapped": normalize_markdown_fences,
                "normalized_file_count": len(normalized_files),
                "normalized_files": normalized_files[:200],
            },
            "baseline_status": "skipped",
            "environment_status": "docker_unavailable",
            "failure_classification": "docker_unavailable",
            "missing_dependency": None,
            "reason": str(exc),
            "exit_code": None,
            "duration_sec": round(time.time() - start, 3),
            "docker_image": image,
            "docker_network": docker_network,
        }


def _parse_image_override(values: list[str]) -> dict[str, str]:
    overrides: dict[str, str] = {}
    for value in values:
        if "=" not in value:
            raise ValueError(f"image override must be language=image: {value}")
        language, image = value.split("=", 1)
        overrides[language.strip()] = image.strip()
    return overrides


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenarios", type=Path, default=ROOT / "data/output/scenarios")
    parser.add_argument("--generated", type=Path, default=ROOT / "data/generated")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--languages", nargs="+", default=["python"])
    parser.add_argument(
        "--case-id",
        action="append",
        default=[],
        help="Restrict a recovery scan to one or more exact case IDs; repeat for multiple cases.",
    )
    parser.add_argument("--target", type=int, default=50)
    parser.add_argument("--small-target", type=int, default=10)
    parser.add_argument("--timeout-sec", type=int, default=300)
    parser.add_argument("--docker-network", default="none")
    parser.add_argument("--image", action="append", default=[], help="Override Docker image, e.g. python=locobench-memory-eval:python")
    parser.add_argument("--keep-workspaces", action="store_true")
    parser.add_argument("--dependency-cache-root", type=Path, default=None)
    parser.add_argument(
        "--bootstrap-node-globals",
        action="store_true",
        help="Expose the pinned image's global node_modules before running the complete npm test script.",
    )
    parser.add_argument(
        "--bootstrap-php-tools",
        action="store_true",
        help="Expose the image's pinned global phpunit binary to a complete Composer test script.",
    )
    parser.add_argument(
        "--normalize-markdown-fences",
        action="store_true",
        help="Before testing the copied workspace, unwrap files that are entirely enclosed in Markdown code fences.",
    )
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    image_overrides = _parse_image_override(args.image)
    candidates = _candidate_scenarios(
        args.scenarios,
        args.generated,
        args.languages,
        normalize_markdown_fences=args.normalize_markdown_fences,
    )
    if args.case_id:
        requested_case_ids = set(args.case_id)
        candidates = [candidate for candidate in candidates if candidate["case_id"] in requested_case_ids]
        found_case_ids = {candidate["case_id"] for candidate in candidates}
        missing_case_ids = sorted(requested_case_ids - found_case_ids)
        if missing_case_ids:
            raise SystemExit(f"Requested case IDs were not eligible candidates: {', '.join(missing_case_ids)}")
    write_jsonl(args.output / "candidates.jsonl", candidates)

    selected: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    for candidate in candidates:
        if len(selected) >= args.target:
            break
        result = _run_case(
            candidate,
            args.output,
            image_overrides,
            args.docker_network,
            args.timeout_sec,
            args.normalize_markdown_fences,
            args.dependency_cache_root,
            args.bootstrap_node_globals,
            args.bootstrap_php_tools,
        )
        results.append(result)
        write_jsonl(args.output / "baseline_results.jsonl", results)
        if result["baseline_status"] == "passed":
            selected.append(result)
            write_json(args.output / f"selected_{min(args.small_target, len(selected)) if len(selected) < args.small_target else args.small_target}.latest.json", selected[: args.small_target])
            write_json(args.output / "selected_latest.json", selected)

    selected_small = selected[: args.small_target]
    selected_target = selected[: args.target]
    write_json(args.output / f"selected_{args.small_target}.json", selected_small)
    write_json(args.output / f"selected_{args.target}.json", selected_target)
    summary = {
        "languages": args.languages,
        "candidate_count": len(candidates),
        "tested_count": len(results),
        "selected_count": len(selected_target),
        "small_target_count": len(selected_small),
        "target": args.target,
        "small_target": args.small_target,
        "case_ids": args.case_id,
        "normalize_markdown_fences": args.normalize_markdown_fences,
        "dependency_cache_root": str(args.dependency_cache_root) if args.dependency_cache_root else None,
        "bootstrap_node_globals": args.bootstrap_node_globals,
        "bootstrap_php_tools": args.bootstrap_php_tools,
        "complete": len(selected_target) >= args.target,
    }
    write_json(args.output / "summary.json", summary)
    if not args.keep_workspaces:
        for workspace in (args.output / "cases").glob("*/workspace"):
            shutil.rmtree(workspace, ignore_errors=True)
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
