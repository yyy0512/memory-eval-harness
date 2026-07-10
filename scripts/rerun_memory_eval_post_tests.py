#!/usr/bin/env python3
"""Re-run post-run tests for existing memory-eval case outputs without re-running agent sessions."""

import argparse
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from locobench.memory_eval.io import read_json, write_json
from locobench.memory_eval.runner import (
    _classify_test_failure,
    _docker_command,
    load_manifest,
    run_docker_preflight,
    run_post_run_tests,
)
from locobench.memory_eval.schema import SessionRunResult


def _session_from_json(data: dict) -> SessionRunResult:
    return SessionRunResult(
        session=int(data.get("session") or 0),
        turns_file=str(data.get("turns_file") or ""),
        turn_count=int(data.get("turn_count") or 0),
        exit_code=int(data.get("exit_code") or 0),
        duration_sec=float(data.get("duration_sec") or 0.0),
        stdout=str(data.get("stdout") or ""),
        stderr=str(data.get("stderr") or ""),
        stream_json_log=str(data.get("stream_json_log") or ""),
        cli_result_json=data.get("cli_result_json"),
        subtype=data.get("subtype"),
        is_error=bool(data.get("is_error")),
        session_id=data.get("session_id"),
        num_turns=data.get("num_turns"),
        stop_reason=data.get("stop_reason"),
        total_cost_usd=float(data.get("total_cost_usd") or 0.0),
        usage=data.get("usage") or {},
        modelUsage=data.get("modelUsage") or {},
        permission_denials=data.get("permission_denials") or [],
        errors=data.get("errors") or [],
        token_metrics=data.get("token_metrics") or {},
        diff=data.get("diff"),
        memory_snapshot=data.get("memory_snapshot"),
        memory_diff=data.get("memory_diff"),
        openviking_snapshot=data.get("openviking_snapshot"),
        openviking_identity=data.get("openviking_identity"),
        files_changed=data.get("files_changed") or [],
    )


def _case_lookup(prepared: Path) -> dict[str, dict]:
    cases = load_manifest(prepared)
    lookup = {}
    for case in cases:
        lookup[str(case.get("case_id") or "")] = case
        lookup[str(case.get("scenario_id") or "")] = case
    return lookup


def _test_result_base(old: dict, command: list[str], executor: str, docker_image: str | None, docker_network: str) -> dict:
    return {
        "command": command,
        "working_dir": str(old.get("working_dir") or "."),
        "source": old.get("source"),
        "test_plan_status": str(old.get("test_plan_status") or "configured"),
        "executor": executor,
        "docker_image": docker_image if executor == "docker" else None,
        "docker_network": docker_network if executor == "docker" else None,
    }


def _rerun_from_existing_test_result(
    paths: dict[str, Path],
    old: dict,
    sessions: list[SessionRunResult],
    test_executor: str | None,
    docker_image: str | None,
    docker_network: str,
) -> dict:
    harness = paths["harness"]
    logs = harness / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    stdout_path = logs / "post_run_tests.stdout"
    stderr_path = logs / "post_run_tests.stderr"
    result_path = harness / "test_result.json"

    command = [str(item) for item in old.get("command") or []]
    executor = str(test_executor or old.get("executor") or "host").strip().lower()
    if executor not in {"host", "docker"}:
        executor = "host"
    selected_docker_image = docker_image or old.get("docker_image") or "locobench-memory-eval:base"
    base = _test_result_base(old, command, executor, selected_docker_image, docker_network)

    if not command or str(old.get("test_plan_status") or "configured") != "configured":
        result = {
            **base,
            "status": "skipped",
            "reason": old.get("reason") or "test plan is not configured",
            "environment_status": "not_configured",
            "integrity_status": "not_checked",
        }
        write_json(result_path, result)
        return result

    if any(session.is_error for session in sessions):
        result = {
            **base,
            "status": "skipped",
            "reason": "case has error sessions; final workspace tests not run",
            "environment_status": "not_run",
            "integrity_status": "not_checked",
        }
        write_json(result_path, result)
        return result

    integrity = old.get("integrity") if isinstance(old.get("integrity"), dict) else {
        "status": old.get("integrity_status") or "not_checked",
        "reason": old.get("integrity_reason"),
    }
    docker_preflight = None
    docker_preflight_path = harness / "docker_preflight.json"
    if executor == "docker":
        docker_preflight = run_docker_preflight(str(selected_docker_image), docker_preflight_path, docker_network=docker_network)

    run_command = (
        _docker_command(paths["workspace"], str(old.get("working_dir") or "."), command, str(selected_docker_image), docker_network)
        if executor == "docker"
        else command
    )
    working_dir = paths["workspace"] / str(old.get("working_dir") or ".")
    cwd = paths["workspace"] if executor == "docker" else (working_dir if working_dir.exists() else paths["workspace"])
    timeout_sec = int(old.get("timeout_sec") or 300)
    start = time.time()
    try:
        completed = subprocess.run(
            run_command,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_sec,
            check=False,
        )
        duration_sec = time.time() - start
        stdout_path.write_text(completed.stdout, encoding="utf-8", errors="replace")
        stderr_path.write_text(completed.stderr, encoding="utf-8", errors="replace")
        classification = _classify_test_failure(completed.stdout, completed.stderr, completed.returncode, executor)
        environment_status = classification["environment_status"]
        integrity_status = str(integrity.get("status") or "not_checked")
        status = "passed" if completed.returncode == 0 else "failed"
        reason = None
        if environment_status != "ready":
            status = "skipped"
            reason = classification.get("failure_classification")
        elif integrity_status == "failed":
            status = "invalid"
            reason = integrity.get("reason")
        result = {
            **base,
            "status": status,
            "exit_code": completed.returncode,
            "duration_sec": round(duration_sec, 3),
            "stdout": str(stdout_path.relative_to(harness)),
            "stderr": str(stderr_path.relative_to(harness)),
            "reason": reason,
            "environment_status": environment_status,
            "failure_classification": classification.get("failure_classification"),
            "missing_dependency": classification.get("missing_dependency"),
            "integrity_status": integrity_status,
            "integrity_reason": integrity.get("reason"),
            "integrity": integrity,
            "docker_preflight": str(docker_preflight_path.relative_to(harness)) if docker_preflight is not None else None,
            "docker_preflight_status": docker_preflight.get("status") if isinstance(docker_preflight, dict) else None,
        }
    except subprocess.TimeoutExpired as exc:
        duration_sec = time.time() - start
        stdout_path.write_text(exc.stdout or "", encoding="utf-8", errors="replace")
        stderr_path.write_text(exc.stderr or "", encoding="utf-8", errors="replace")
        result = {
            **base,
            "status": "timeout",
            "exit_code": None,
            "duration_sec": round(duration_sec, 3),
            "stdout": str(stdout_path.relative_to(harness)),
            "stderr": str(stderr_path.relative_to(harness)),
            "reason": f"test command timed out after {timeout_sec}s",
            "environment_status": "timeout",
            "failure_classification": "timeout",
            "missing_dependency": None,
            "integrity_status": str(integrity.get("status") or "not_checked"),
            "integrity_reason": integrity.get("reason"),
            "integrity": integrity,
            "docker_preflight": str(docker_preflight_path.relative_to(harness)) if docker_preflight is not None else None,
            "docker_preflight_status": docker_preflight.get("status") if isinstance(docker_preflight, dict) else None,
        }
    write_json(result_path, result)
    return result


def rerun_variant(prepared: Path, run_dir: Path, test_executor: str | None, docker_image: str | None, docker_network: str) -> dict:
    lookup = _case_lookup(prepared) if (prepared / "manifest.jsonl").exists() else None
    updated = 0
    skipped = 0
    statuses: dict[str, int] = {}
    for result_path in sorted(run_dir.glob("*/harness/result.json")):
        case_result = read_json(result_path)
        harness = result_path.parent
        paths = {
            "harness": harness,
            "workspace": harness.parent / "agent_root" / "workspace",
        }
        sessions = [_session_from_json(item) for item in case_result.get("sessions") or [] if isinstance(item, dict)]
        if lookup is not None:
            case = lookup.get(str(case_result.get("case_id") or "")) or lookup.get(str(case_result.get("scenario_id") or ""))
            if case is None:
                skipped += 1
                continue
            test_result = run_post_run_tests(
                prepared,
                case,
                paths,
                sessions,
                test_executor=test_executor,
                docker_image=docker_image,
                docker_network=docker_network,
            )
        else:
            old_test_result = case_result.get("test_result") or read_json(harness / "test_result.json")
            test_result = _rerun_from_existing_test_result(paths, old_test_result, sessions, test_executor, docker_image, docker_network)
        case_result["test_result"] = test_result
        write_json(result_path, case_result)
        updated += 1
        status = str(test_result.get("status") or "unknown")
        statuses[status] = statuses.get(status, 0) + 1
    summary = {"run_dir": str(run_dir), "updated_cases": updated, "skipped_cases": skipped, "test_result_statuses": statuses}
    write_json(run_dir / "post_run_rerun_summary.json", summary)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared", required=True, type=Path)
    parser.add_argument("--runs", required=True, nargs="+", type=Path)
    parser.add_argument("--test-executor", choices=["host", "docker"], default=None)
    parser.add_argument("--docker-image", default=None)
    parser.add_argument("--docker-network", default="none")
    args = parser.parse_args()

    for run_dir in args.runs:
        summary = rerun_variant(args.prepared.resolve(), run_dir.resolve(), args.test_executor, args.docker_image, args.docker_network)
        print(f"{run_dir}: updated={summary['updated_cases']} skipped={summary['skipped_cases']} statuses={summary['test_result_statuses']}", flush=True)


if __name__ == "__main__":
    main()
