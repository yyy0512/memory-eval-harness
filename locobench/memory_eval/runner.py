"""Run Code Agent CLI sessions for the LoCoBench memory eval harness."""

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .io import copy_tree_clean, read_jsonl, snapshot_directory, write_json, write_jsonl
from .schema import CaseRunResult, SessionRunResult, TokenMetrics


def load_manifest(prepared_dir: Path) -> List[Dict[str, Any]]:
    """Load prepared cases from manifest.jsonl."""
    manifest = prepared_dir / "manifest.jsonl"
    if not manifest.exists():
        raise FileNotFoundError(f"Prepared manifest not found: {manifest}")
    return read_jsonl(manifest)


def select_case(prepared_dir: Path, scenario_id: Optional[str] = None) -> Dict[str, Any]:
    """Select one case from the prepared manifest."""
    cases = load_manifest(prepared_dir)
    if not cases:
        raise ValueError(f"No cases found in {prepared_dir / 'manifest.jsonl'}")
    if scenario_id is None:
        return cases[0]
    for case in cases:
        if case.get("scenario_id") == scenario_id:
            return case
    raise ValueError(f"Scenario id not found in manifest: {scenario_id}")


def normalize_agent_bin(agent_bin: str) -> str:
    """Resolve path-like agent binaries before running from an isolated workspace."""
    path = Path(agent_bin)
    if path.is_absolute() or "/" in agent_bin:
        return str(path.resolve())
    return agent_bin


def build_agent_command(agent_bin: str, memory_mode: str, memory_dir: Path) -> List[str]:
    """Build a Code Agent CLI command for one stream-json benchmark session."""
    cmd = [
        normalize_agent_bin(agent_bin),
        "--dangerously-skip-permissions",
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    if memory_mode == "on":
        cmd.extend(["--settings", json.dumps({"autoMemoryDirectory": str(memory_dir)})])
    elif memory_mode == "off":
        cmd.extend(["--settings", json.dumps({"autoMemoryEnabled": False})])
    elif memory_mode == "bare":
        cmd.insert(1, "--bare")
    else:
        raise ValueError(f"Unsupported memory mode: {memory_mode}")
    return cmd


def extract_final_result(stream_log: Path) -> Optional[Dict[str, Any]]:
    """Return the last type=result event from a stream-json log."""
    final_result = None
    if not stream_log.exists():
        return None
    with stream_log.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "result":
                final_result = event
    return final_result


def setup_case_workspace(case: Dict[str, Any], output_dir: Path) -> Dict[str, Path]:
    """Create isolated agent_root and harness directories for one case."""
    return setup_workspace_at(case, output_dir / case["case_id"])


def setup_workspace_at(case: Dict[str, Any], case_root: Path) -> Dict[str, Path]:
    """Create isolated agent_root and harness directories at an exact case root."""
    agent_root = case_root / "agent_root"
    workspace = agent_root / "workspace"
    memory = agent_root / "memory"
    harness = case_root / "harness"
    project_source = Path(case["project_source"])

    copy_tree_clean(project_source, workspace)
    memory.mkdir(parents=True, exist_ok=True)
    for child in (
        harness / "logs",
        harness / "metrics",
        harness / "snapshots",
        harness / "home",
        harness / "xdg_config",
        harness / "xdg_cache",
    ):
        child.mkdir(parents=True, exist_ok=True)
    init_git_baseline(workspace)
    return {
        "case_root": case_root,
        "agent_root": agent_root,
        "workspace": workspace,
        "memory": memory,
        "harness": harness,
    }


def init_git_baseline(workspace: Path) -> None:
    """Initialize a git baseline in the agent-visible workspace if possible."""
    if (workspace / ".git").exists():
        return
    subprocess.run(["git", "init"], cwd=workspace, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    subprocess.run(["git", "config", "user.email", "memory-eval@example.invalid"], cwd=workspace, check=False)
    subprocess.run(["git", "config", "user.name", "Memory Eval Harness"], cwd=workspace, check=False)
    subprocess.run(["git", "add", "."], cwd=workspace, check=False)
    subprocess.run(["git", "commit", "-m", "baseline"], cwd=workspace, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def capture_git_diff(workspace: Path, diff_path: Path) -> List[str]:
    """Save git diff and return changed file paths."""
    diff_path.parent.mkdir(parents=True, exist_ok=True)
    diff = subprocess.run(
        ["git", "diff", "--binary"],
        cwd=workspace,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    diff_path.write_text(diff.stdout, encoding="utf-8")
    status = subprocess.run(
        ["git", "status", "--short"],
        cwd=workspace,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    files = []
    for line in status.stdout.splitlines():
        if line.strip():
            files.append(line[3:].strip())
    return files


def make_session_env(harness_dir: Path) -> Dict[str, str]:
    """Build an isolated environment for one CLI process."""
    env = os.environ.copy()
    env.setdefault("CODEAGENT3_CONFIG_DIR", str(Path.home() / ".cac"))
    env.pop("CODEAGENT3_SERVER_CONFIG_ISOLATION", None)
    env["HOME"] = str(harness_dir / "home")
    env["XDG_CONFIG_HOME"] = str(harness_dir / "xdg_config")
    env["XDG_CACHE_HOME"] = str(harness_dir / "xdg_cache")
    return env


def run_agent_process(
    cmd: List[str],
    turns_file: Path,
    stream_log: Path,
    stderr_log: Path,
    workspace: Path,
    harness: Path,
    timeout_sec: int,
) -> int:
    """Run the CLI with prepared turns streamed through stdin."""
    with turns_file.open("rb") as input_handle:
        input_data = input_handle.read()
    with stream_log.open("wb") as stdout, stderr_log.open("wb") as stderr:
        try:
            completed = subprocess.run(
                cmd,
                cwd=workspace,
                input=input_data,
                stdout=stdout,
                stderr=stderr,
                env=make_session_env(harness),
                timeout=timeout_sec,
                check=False,
            )
        except subprocess.TimeoutExpired:
            stderr.write(f"Timed out after {timeout_sec} seconds\n".encode("utf-8"))
            return 124
    return completed.returncode


def run_session(
    prepared_dir: Path,
    case: Dict[str, Any],
    paths: Dict[str, Path],
    turn: Dict[str, Any],
    agent_bin: str,
    memory_mode: str,
    timeout_sec: int,
) -> SessionRunResult:
    """Run one prepared benchmark session as an independent CLI process."""
    session = int(turn["session"])
    harness = paths["harness"]
    workspace = paths["workspace"]
    memory = paths["memory"]
    logs = harness / "logs"
    metrics = harness / "metrics"
    snapshots = harness / "snapshots"
    case_dir = prepared_dir / "cases" / case["scenario_id"]
    turns_file = case_dir / turn["file"]

    stream_log = logs / f"session_{session}.stream.jsonl"
    stderr_log = logs / f"session_{session}.stderr"
    result_json = logs / f"session_{session}.result.json"
    token_metrics_json = metrics / f"session_{session}.tokens.json"
    diff_path = snapshots / f"session_{session}.diff"
    memory_snapshot = snapshots / f"session_{session}_memory"

    cmd = build_agent_command(agent_bin, memory_mode, memory)
    start = time.monotonic()
    exit_code = run_agent_process(cmd, turns_file, stream_log, stderr_log, workspace, harness, timeout_sec)
    duration_sec = time.monotonic() - start

    result = extract_final_result(stream_log)
    if result is not None:
        write_json(result_json, result)
        token_metrics = TokenMetrics.from_result(result).to_dict()
        write_json(token_metrics_json, token_metrics)
    else:
        token_metrics = TokenMetrics().to_dict()

    files_changed = capture_git_diff(workspace, diff_path)
    snapshot_directory(memory, memory_snapshot)

    usage = (result or {}).get("usage") or {}
    model_usage = (result or {}).get("modelUsage") or {}
    return SessionRunResult(
        session=session,
        turns_file=turn["file"],
        turn_count=int(turn.get("turn_count") or 0),
        exit_code=exit_code,
        duration_sec=duration_sec,
        stdout=str(stream_log.relative_to(harness)),
        stderr=str(stderr_log.relative_to(harness)),
        stream_json_log=str(stream_log.relative_to(harness)),
        cli_result_json=str(result_json.relative_to(harness)) if result is not None else None,
        subtype=(result or {}).get("subtype"),
        is_error=bool((result or {}).get("is_error")) or exit_code != 0 or result is None,
        session_id=(result or {}).get("session_id"),
        num_turns=(result or {}).get("num_turns"),
        stop_reason=(result or {}).get("stop_reason"),
        total_cost_usd=float((result or {}).get("total_cost_usd") or 0.0),
        usage=usage,
        modelUsage=model_usage,
        permission_denials=(result or {}).get("permission_denials") or [],
        errors=(result or {}).get("errors") or ([] if result is not None else ["No result event found"]),
        token_metrics=token_metrics,
        diff=str(diff_path.relative_to(harness)),
        memory_snapshot=str(memory_snapshot.relative_to(harness)),
        memory_diff=None,
        files_changed=files_changed,
    )


def build_case_result(
    case: Dict[str, Any],
    memory_mode: str,
    agent_bin: str,
    paths: Dict[str, Path],
    session_results: List[SessionRunResult],
    errors: Optional[List[str]] = None,
) -> CaseRunResult:
    """Build a case-level result object."""
    harness = paths["harness"]
    final_diff = harness / "snapshots" / "final.diff"
    capture_git_diff(paths["workspace"], final_diff)
    final_memory = harness / "snapshots" / "final_memory"
    snapshot_directory(paths["memory"], final_memory)
    return CaseRunResult(
        scenario_id=case["scenario_id"],
        case_id=case["case_id"],
        variant="memory_on" if memory_mode == "on" else "memory_off" if memory_mode == "off" else memory_mode,
        run_environment={
            "agent_bin": agent_bin,
            "memory_mode": memory_mode,
            "home": str(harness / "home"),
            "xdg_config_home": str(harness / "xdg_config"),
            "xdg_cache_home": str(harness / "xdg_cache"),
        },
        sessions=session_results,
        final_diff=str(final_diff.relative_to(harness)),
        final_memory_snapshot=str(final_memory.relative_to(harness)),
        errors=errors or [],
    )


def run_smoke(
    prepared_dir: Path,
    agent_bin: str,
    scenario_id: Optional[str],
    session: int,
    memory_mode: str,
    output_dir: Path,
    timeout_sec: int = 1800,
) -> Dict[str, Any]:
    """Run a single case/session smoke test."""
    prepared_dir = prepared_dir.resolve()
    output_dir = output_dir.resolve()
    case = select_case(prepared_dir, scenario_id)
    matching_turns = [turn for turn in case.get("turns", []) if int(turn.get("session", 0)) == session]
    if not matching_turns:
        raise ValueError(f"Session {session} not found for {case['scenario_id']}")

    paths = setup_workspace_at(case, output_dir)

    result = run_session(prepared_dir, case, paths, matching_turns[0], agent_bin, memory_mode, timeout_sec)
    case_result = build_case_result(case, memory_mode, agent_bin, paths, [result])
    write_json(paths["harness"] / "result.json", case_result.to_dict())
    permission_denials_count = len(result.permission_denials or [])
    status = "pass" if result.exit_code == 0 and not result.is_error and permission_denials_count == 0 else "fail"
    summary = {
        "status": status,
        "agent_bin": agent_bin,
        "memory_mode": memory_mode,
        "scenario_id": case["scenario_id"],
        "session": session,
        "exit_code": result.exit_code,
        "result_found": result.cli_result_json is not None,
        "is_error": result.is_error,
        "subtype": result.subtype,
        "has_usage": bool(result.usage),
        "has_model_usage": bool(result.modelUsage),
        "has_total_cost_usd": result.total_cost_usd is not None,
        "permission_denials_count": permission_denials_count,
        "memory_files_count": sum(1 for path in paths["memory"].rglob("*") if path.is_file()) if paths["memory"].exists() else 0,
        "duration_ms": result.token_metrics.get("duration_ms", 0),
    }
    write_json(paths["harness"] / "smoke_result.json", summary)
    return summary


def run_batch(
    prepared_dir: Path,
    agent_bin: str,
    memory_mode: str,
    output_dir: Path,
    timeout_sec: int = 1800,
    limit: Optional[int] = None,
    scenario_id: Optional[str] = None,
    resume: bool = False,
    progress: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    """Run prepared memory eval cases for one variant."""
    prepared_dir = prepared_dir.resolve()
    output_dir = output_dir.resolve()
    cases = load_manifest(prepared_dir)
    if scenario_id:
        cases = [case for case in cases if case.get("scenario_id") == scenario_id]
    if limit:
        cases = cases[:limit]

    def report(message: str) -> None:
        if progress is not None:
            progress(message)

    report(f"Starting batch: {len(cases)} case(s), memory_mode={memory_mode}")
    completed = 0
    failed = 0
    skipped = 0
    for index, case in enumerate(cases, start=1):
        scenario = case.get("scenario_id")
        turns = case.get("turns", [])
        result_path = output_dir / case["case_id"] / "harness" / "result.json"
        if resume and result_path.exists():
            skipped += 1
            report(f"Skipping case {index}/{len(cases)}: {scenario} already has result.json")
            continue
        report(f"Starting case {index}/{len(cases)}: {scenario} ({len(turns)} session(s))")
        try:
            paths = setup_case_workspace(case, output_dir)
            session_results = []
            for turn in turns:
                session = int(turn["session"])
                report(f"Starting session {session} for {scenario}")
                session_result = run_session(prepared_dir, case, paths, turn, agent_bin, memory_mode, timeout_sec)
                session_results.append(session_result)
                status = "error" if session_result.is_error else "success"
                report(f"Finished session {session} for {scenario}: {status} in {session_result.duration_sec:.1f}s")
            case_result = build_case_result(case, memory_mode, agent_bin, paths, session_results)
            write_json(paths["harness"] / "result.json", case_result.to_dict())
            if any(session.is_error for session in session_results):
                failed += 1
                case_status = "failed"
            else:
                completed += 1
                case_status = "completed"
            report(f"Finished case {index}/{len(cases)}: {scenario} status={case_status}")
        except Exception as exc:  # noqa: BLE001 - preserve case-level failure details for benchmark runs.
            failed += 1
            error_dir = output_dir / case.get("case_id", "unknown") / "harness"
            error_dir.mkdir(parents=True, exist_ok=True)
            write_json(error_dir / "result.json", {
                "scenario_id": case.get("scenario_id"),
                "case_id": case.get("case_id"),
                "variant": memory_mode,
                "run_environment": {"agent_bin": agent_bin, "memory_mode": memory_mode},
                "sessions": [],
                "errors": [str(exc)],
            })
            report(f"Finished case {index}/{len(cases)}: {scenario} status=failed error={exc}")

    summary = {
        "case_count": len(cases),
        "completed_cases": completed,
        "failed_cases": failed,
        "skipped_cases": skipped,
        "memory_mode": memory_mode,
    }
    write_json(output_dir / "run_summary.json", summary)
    report(f"Run summary: completed={completed} failed={failed} skipped={skipped} total={len(cases)}")
    return summary
