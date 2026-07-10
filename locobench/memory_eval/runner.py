"""Run Code Agent CLI sessions for the LoCoBench memory eval harness."""

import json
import fcntl
import os
import re
import shlex
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .io import (
    copy_tree_clean,
    read_json,
    read_jsonl,
    sha256_file,
    sha256_prepared_case,
    sha256_prepared_dataset,
    snapshot_directory,
    snapshot_workspace_delta,
    tree_file_hashes,
    write_json,
    write_jsonl,
)
from .schema import CaseRunResult, SessionRunResult, TokenMetrics


OPENVIKING_MEMORY_MODES = {"openviking", "openviking_on"}
NATIVE_MEMORY_MODES = {"on", "native", "memory_on", "native_memory_on"}
OFF_MEMORY_MODES = {"off", "memory_off"}
BARE_MEMORY_MODES = {"bare"}
SUPPORTED_MEMORY_MODES = OPENVIKING_MEMORY_MODES | NATIVE_MEMORY_MODES | OFF_MEMORY_MODES | BARE_MEMORY_MODES
DEFAULT_OPENVIKING_URL = "http://127.0.0.1:1933"
DEFAULT_OPENVIKING_ACCOUNT = "memory-eval"
DEFAULT_MEMORY_SETTLE_SEC = 10.0
RUN_METADATA_NAME = ".memory_eval_run.json"
RUN_LOCK_NAME = ".memory_eval_run.lock"


def load_manifest(prepared_dir: Path) -> List[Dict[str, Any]]:
    """Load prepared cases from manifest.jsonl."""
    manifest = prepared_dir / "manifest.jsonl"
    if not manifest.exists():
        raise FileNotFoundError(f"Prepared manifest not found: {manifest}")
    rows = read_jsonl(manifest)
    for row in rows:
        scenario_id = str(row.get("scenario_id") or "")
        row["_prepared_dir"] = str(prepared_dir.resolve())
        row["_case_dir"] = str((prepared_dir / "cases" / scenario_id).resolve())
        raw_project_source = Path(str(row.get("project_source") or ""))
        if raw_project_source and not raw_project_source.is_absolute():
            row["project_source"] = str((prepared_dir / raw_project_source).resolve())
    return rows


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


def canonical_memory_mode(memory_mode: str) -> str:
    """Normalize legacy and explicit memory mode names."""
    mode = str(memory_mode or "").strip()
    if mode in SUPPORTED_MEMORY_MODES:
        if mode == "openviking_on":
            return "openviking"
        if mode in {"memory_on", "native_memory_on"}:
            return "native"
        if mode == "memory_off":
            return "off"
        return mode
    raise ValueError(f"Unsupported memory mode: {memory_mode}")


def variant_for_memory_mode(memory_mode: str) -> str:
    """Return the result/report variant label for a memory mode."""
    mode = str(memory_mode or "").strip()
    canonical = canonical_memory_mode(mode)
    if mode in {"on", "memory_on"}:
        return "memory_on"
    if mode in {"off", "memory_off"}:
        return "memory_off"
    if canonical == "native":
        return "native_memory_on"
    if canonical == "openviking":
        return "openviking_on"
    return canonical


def snapshot_prepared_inputs(prepared_dir: Path, case: Dict[str, Any], harness: Path) -> Dict[str, Any]:
    """Embed and verify the exact prepared case used for a run."""
    scenario_id = str(case.get("scenario_id") or "")
    source_case_dir = prepared_dir / "cases" / scenario_id
    if not source_case_dir.is_dir():
        raise FileNotFoundError(f"Prepared case directory not found: {source_case_dir}")

    actual_case_hash = sha256_prepared_case(source_case_dir)
    actual_dataset_hash = sha256_prepared_dataset(prepared_dir)
    summary_path = prepared_dir / "summary.json"
    summary = read_json(summary_path) if summary_path.is_file() else {}
    sealed = summary.get("schema_version") == "memory_eval_prepared_v2_immutable"
    declared_dataset_hash = str(summary.get("prepared_dataset_sha256") or "")
    declared_case_hash = str((case.get("hashes") or {}).get("prepared_case_sha256") or "")
    if sealed and declared_dataset_hash != actual_dataset_hash:
        raise ValueError("Prepared dataset hash mismatch; refuse to run mutated prepared inputs")
    if sealed and declared_case_hash != actual_case_hash:
        raise ValueError(f"Prepared case hash mismatch for {scenario_id}; refuse to run mutated inputs")

    snapshot_root = harness / "prepared_snapshot"
    snapshot_case_dir = snapshot_root / "case"
    snapshot_directory(source_case_dir, snapshot_case_dir)
    snapshot_case_hash = sha256_prepared_case(snapshot_case_dir)
    if snapshot_case_hash != actual_case_hash:
        raise ValueError(f"Prepared snapshot verification failed for {scenario_id}")
    manifest_entry_path = snapshot_root / "manifest_entry.json"
    write_json(manifest_entry_path, case)
    provenance = {
        "schema_version": "memory_eval_run_provenance_v1",
        "verification_status": "sealed_verified" if sealed else "legacy_computed_verified",
        "source_prepared_dir": str(prepared_dir),
        "prepared_schema_version": summary.get("schema_version"),
        "declared_dataset_sha256": declared_dataset_hash or None,
        "prepared_dataset_sha256": actual_dataset_hash,
        "declared_case_sha256": declared_case_hash or None,
        "prepared_case_sha256": actual_case_hash,
        "snapshot_case_sha256": snapshot_case_hash,
        "manifest_entry_sha256": sha256_file(manifest_entry_path),
        "scenario_json_sha256": (case.get("hashes") or {}).get("scenario_json_sha256"),
        "project_tree_sha256": (case.get("hashes") or {}).get("project_tree_sha256"),
        "scenario_id": scenario_id,
        "case_id": case.get("case_id"),
    }
    provenance_path = snapshot_root / "provenance.json"
    write_json(provenance_path, provenance)
    return provenance


def memory_backend_for_mode(memory_mode: str) -> str:
    """Return the backend family represented by a memory mode."""
    canonical = canonical_memory_mode(memory_mode)
    if canonical in NATIVE_MEMORY_MODES or canonical == "native":
        return "native"
    if canonical == "off":
        return "off"
    if canonical == "openviking":
        return "openviking"
    return canonical


def should_settle_memory(memory_mode: str, memory_settle_sec: float) -> bool:
    """Return whether this memory mode should pause between sessions."""
    if memory_settle_sec <= 0:
        return False
    return memory_backend_for_mode(memory_mode) in {"native", "openviking"}


def settle_memory_between_sessions(memory_mode: str, memory_settle_sec: float) -> Dict[str, Any]:
    """Wait for memory backends to finish best-effort background capture/indexing."""
    backend = memory_backend_for_mode(memory_mode)
    requested_sec = max(0.0, float(memory_settle_sec or 0.0))
    result: Dict[str, Any] = {
        "enabled": should_settle_memory(memory_mode, requested_sec),
        "memory_mode": memory_mode,
        "memory_backend": backend,
        "strategy": "fixed_sleep",
        "requested_sec": requested_sec,
        "duration_sec": 0.0,
    }
    if not result["enabled"]:
        result["status"] = "skipped"
        return result

    start = time.monotonic()
    time.sleep(requested_sec)
    result["duration_sec"] = round(time.monotonic() - start, 3)
    result["status"] = "completed"
    return result


def is_openviking_mode(memory_mode: str) -> bool:
    return canonical_memory_mode(memory_mode) in OPENVIKING_MEMORY_MODES or canonical_memory_mode(memory_mode) == "openviking"


def build_agent_command(
    agent_bin: str,
    memory_mode: str,
    memory_dir: Path,
    plugin_dir: Optional[Path] = None,
) -> List[str]:
    """Build a Code Agent CLI command for one stream-json benchmark session."""
    canonical = canonical_memory_mode(memory_mode)
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
    if canonical in {"on", "native", "memory_on", "native_memory_on"}:
        cmd.extend(["--settings", json.dumps({"autoMemoryDirectory": str(memory_dir)})])
    elif canonical in {"off", "openviking"}:
        cmd.extend(["--settings", json.dumps({"autoMemoryEnabled": False})])
    elif canonical == "bare":
        cmd.insert(1, "--bare")

    if canonical == "openviking":
        if plugin_dir is None:
            raise ValueError(f"memory mode {memory_mode!r} requires --plugin-dir")
        cmd.extend(["--plugin-dir", str(plugin_dir.resolve())])
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

    if memory.exists():
        shutil.rmtree(memory)
    if harness.exists():
        shutil.rmtree(harness)
    copy_tree_clean(project_source, workspace)
    memory.mkdir(parents=True, exist_ok=True)
    for child in (
        harness / "logs",
        harness / "metrics",
        harness / "snapshots",
        harness / "session_envs",
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
    """Save tracked and untracked workspace changes and return changed file paths."""
    diff_path.parent.mkdir(parents=True, exist_ok=True)
    diff = subprocess.run(
        ["git", "diff", "HEAD", "--binary", "--"],
        cwd=workspace,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    status = subprocess.run(
        ["git", "status", "--short"],
        cwd=workspace,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    files = []
    diff_pieces = [diff.stdout]
    for line in status.stdout.splitlines():
        if line.strip():
            rel = line[3:].strip()
            files.append(rel)
            if line.startswith("??") and (workspace / rel).is_file():
                untracked = subprocess.run(
                    ["git", "diff", "--no-index", "--binary", "--", "/dev/null", rel],
                    cwd=workspace,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    check=False,
                )
                diff_pieces.append(untracked.stdout)
    diff_path.write_text("".join(diff_pieces), encoding="utf-8")
    return files


def _sanitize_identity_part(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in str(value or "")).strip("-") or "unknown"


def build_openviking_identity(
    memory_mode: str,
    case: Dict[str, Any],
    openviking_url: str = DEFAULT_OPENVIKING_URL,
    openviking_account: str = DEFAULT_OPENVIKING_ACCOUNT,
    openviking_user_prefix: Optional[str] = None,
    openviking_peer_prefix: Optional[str] = None,
    run_namespace: Optional[str] = None,
) -> Optional[Dict[str, str]]:
    """Build per-run, per-case OpenViking identity for OpenViking-backed variants."""
    if not is_openviking_mode(memory_mode):
        return None
    variant = variant_for_memory_mode(memory_mode)
    case_id = _sanitize_identity_part(str(case.get("case_id") or case.get("scenario_id") or "case"))
    user_prefix = _sanitize_identity_part(openviking_user_prefix or openviking_account or DEFAULT_OPENVIKING_ACCOUNT)
    peer_prefix = _sanitize_identity_part(openviking_peer_prefix or user_prefix)
    namespace = _sanitize_identity_part(run_namespace or "unscoped-run")
    suffix = f"{namespace}-{variant}-{case_id}"
    return {
        "url": openviking_url or DEFAULT_OPENVIKING_URL,
        "account": openviking_account or DEFAULT_OPENVIKING_ACCOUNT,
        "user": f"{user_prefix}-{suffix}",
        "peer_id": f"{peer_prefix}-{suffix}",
        "run_namespace": namespace,
    }


def _acquire_output_lock(output_dir: Path):
    """Hold a non-blocking process lock so two batches cannot mutate one run directory."""
    output_dir.mkdir(parents=True, exist_ok=True)
    handle = (output_dir / RUN_LOCK_NAME).open("a+", encoding="utf-8")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        handle.close()
        raise RuntimeError(f"another memory-eval process is already using output directory: {output_dir}") from exc
    handle.seek(0)
    handle.truncate()
    handle.write(json.dumps({"pid": os.getpid(), "output_dir": str(output_dir)}, ensure_ascii=False) + "\n")
    handle.flush()
    return handle


def _initialize_run_namespace(
    output_dir: Path,
    resume: bool,
    requested: Optional[str] = None,
    variant: Optional[str] = None,
    prepared_dir: Optional[Path] = None,
) -> str:
    """Create or restore a run namespace used by remote memory backends."""
    metadata_path = output_dir / RUN_METADATA_NAME
    if resume and metadata_path.exists():
        metadata = read_json(metadata_path)
        existing_variant = str(metadata.get("variant") or "")
        if existing_variant and variant and existing_variant != variant:
            raise ValueError(
                f"cannot resume {variant!r} in output owned by variant {existing_variant!r}: {output_dir}"
            )
        existing = str(metadata.get("run_namespace") or "").strip()
        if existing:
            return _sanitize_identity_part(existing)
    namespace = _sanitize_identity_part(requested or uuid.uuid4().hex[:16])
    write_json(
        metadata_path,
        {
            "schema_version": "memory_eval_run_v1",
            "run_namespace": namespace,
            "output_dir": str(output_dir),
            "variant": variant,
            "prepared_dir": str(prepared_dir) if prepared_dir is not None else None,
        },
    )
    return namespace


def _validate_case_output_isolation(
    cases: List[Dict[str, Any]],
    output_dir: Path,
    resume: bool,
    expected_variant: Optional[str] = None,
) -> None:
    """Reject case path collisions and accidental reuse of a completed non-resume output."""
    seen: Dict[str, str] = {}
    for case in cases:
        case_id = str(case.get("case_id") or "")
        scenario_id = str(case.get("scenario_id") or "")
        if case_id in seen and seen[case_id] != scenario_id:
            raise ValueError(
                f"case_id collision would share one workspace: {case_id!r} is used by "
                f"{seen[case_id]!r} and {scenario_id!r}"
            )
        seen[case_id] = scenario_id
    if not resume and any(output_dir.glob("*/harness/result.json")):
        raise ValueError(
            f"output directory already contains case results: {output_dir}; "
            "use a fresh output directory or --resume"
        )
    if resume and expected_variant:
        for result_path in output_dir.glob("*/harness/result.json"):
            existing = read_json(result_path)
            existing_variant = str(existing.get("variant") or "")
            if existing_variant and existing_variant != expected_variant:
                raise ValueError(
                    f"cannot mix variant {expected_variant!r} with {existing_variant!r} in {output_dir}"
                )


def make_session_env(
    environment_root: Path,
    openviking_identity: Optional[Dict[str, str]] = None,
    openviking_debug: bool = True,
) -> Dict[str, str]:
    """Build an isolated environment for one CLI process."""
    config_dir = environment_root / "codeagent_config"
    for child in (
        environment_root / "home",
        environment_root / "xdg_config",
        environment_root / "xdg_cache",
        config_dir,
    ):
        child.mkdir(parents=True, exist_ok=True)
    host_home = Path(os.environ.get("HOME") or str(Path.home()))
    host_config_dir = Path(os.environ.get("CODEAGENT3_CONFIG_DIR") or str(host_home / ".cac"))
    host_config = host_home / ".cac.json"
    isolated_config = config_dir / ".cac.json"
    if host_config.exists() and host_config.is_file() and not isolated_config.exists():
        shutil.copy2(host_config, isolated_config)
    for settings_name in ("settings.json", "settings.local.json"):
        source = host_config_dir / settings_name
        target = config_dir / settings_name
        if source.exists() and source.is_file() and not target.exists():
            shutil.copy2(source, target)
    env = os.environ.copy()
    env["CODEAGENT3_CONFIG_DIR"] = str(config_dir)
    env["CODEAGENT3_SERVER_CONFIG_ISOLATION"] = "1"
    env["HOME"] = str(environment_root / "home")
    env["XDG_CONFIG_HOME"] = str(environment_root / "xdg_config")
    env["XDG_CACHE_HOME"] = str(environment_root / "xdg_cache")
    if openviking_identity:
        env["OPENVIKING_MEMORY_ENABLED"] = "1"
        env["OPENVIKING_URL"] = openviking_identity["url"]
        env["OPENVIKING_ACCOUNT"] = openviking_identity["account"]
        env["OPENVIKING_USER"] = openviking_identity["user"]
        env["OPENVIKING_PEER_ID"] = openviking_identity["peer_id"]
        env["OPENVIKING_DEBUG"] = "1" if openviking_debug else "0"
    return env


def _openviking_headers(identity: Dict[str, str]) -> Dict[str, str]:
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-OpenViking-Account": identity.get("account", ""),
        "X-OpenViking-User": identity.get("user", ""),
    }
    api_key = os.environ.get("OPENVIKING_API_KEY")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _probe_openviking_json(
    url: str,
    identity: Dict[str, str],
    method: str = "GET",
    payload: Optional[Dict[str, Any]] = None,
    timeout: float = 5.0,
) -> Dict[str, Any]:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method, headers=_openviking_headers(identity))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - benchmark probe uses user-supplied eval URL.
            body = response.read().decode("utf-8", errors="replace")
            try:
                parsed: Any = json.loads(body) if body else None
            except json.JSONDecodeError:
                parsed = body
            return {"ok": 200 <= response.status < 300, "status": response.status, "body": parsed}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        try:
            parsed = json.loads(body) if body else None
        except json.JSONDecodeError:
            parsed = body
        return {"ok": False, "status": exc.code, "body": parsed, "error": str(exc)}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"ok": False, "status": None, "body": None, "error": str(exc)}


def snapshot_openviking(
    harness: Path,
    snapshot_dir: Path,
    identity: Optional[Dict[str, str]],
    session_id: Optional[str] = None,
    search_query: Optional[str] = None,
    local_environment_root: Optional[Path] = None,
) -> Optional[Path]:
    """Snapshot OpenViking hook state/logs and lightweight server probes."""
    if not identity:
        return None
    if snapshot_dir.exists():
        import shutil

        shutil.rmtree(snapshot_dir)
    environment_root = local_environment_root or harness
    state_src = environment_root / "home" / ".openviking" / "state"
    logs_src = environment_root / "home" / ".openviking" / "logs"
    snapshot_directory(state_src, snapshot_dir / "state")
    snapshot_directory(logs_src, snapshot_dir / "logs")

    server_dir = snapshot_dir / "server"
    base_url = identity["url"].rstrip("/")
    write_json(server_dir / "health.json", _probe_openviking_json(f"{base_url}/health", identity))
    write_json(server_dir / "system_status.json", _probe_openviking_json(f"{base_url}/api/v1/system/status", identity))
    query = search_query or session_id or identity.get("peer_id") or identity.get("user") or "memory eval"
    write_json(
        server_dir / "search_probe.json",
        _probe_openviking_json(
            f"{base_url}/api/v1/search/find",
            identity,
            method="POST",
            payload={
                "query": query,
                "target_uri": "viking://user/memories",
                "limit": 10,
                "score_threshold": 0,
            },
        ),
    )
    if session_id:
        ov_session_id = f"codeagent-{session_id}"
        quoted = urllib.parse.quote(ov_session_id, safe="")
        write_json(
            server_dir / "session_context.json",
            _probe_openviking_json(f"{base_url}/api/v1/sessions/{quoted}/context", identity),
        )
    else:
        write_json(server_dir / "session_context.json", {"ok": False, "status": None, "error": "missing codeagent session_id"})
    return snapshot_dir


def run_agent_process(
    cmd: List[str],
    turns_file: Path,
    stream_log: Path,
    stderr_log: Path,
    workspace: Path,
    environment_root: Path,
    timeout_sec: int,
    openviking_identity: Optional[Dict[str, str]] = None,
    openviking_debug: bool = True,
) -> int:
    """Run the CLI with prepared turns streamed through stdin."""
    with turns_file.open("rb") as input_handle:
        input_data = input_handle.read()
    try:
        with stream_log.open("wb") as stdout, stderr_log.open("wb") as stderr:
            try:
                completed = subprocess.run(
                    cmd,
                    cwd=workspace,
                    input=input_data,
                    stdout=stdout,
                    stderr=stderr,
                    env=make_session_env(environment_root, openviking_identity, openviking_debug),
                    timeout=timeout_sec,
                    check=False,
                )
            except subprocess.TimeoutExpired:
                stderr.write(f"Timed out after {timeout_sec} seconds\n".encode("utf-8"))
                return 124
        return completed.returncode
    finally:
        for config_copy in (
            environment_root / "codeagent_config" / ".cac.json",
            environment_root / "codeagent_config" / "settings.json",
            environment_root / "codeagent_config" / "settings.local.json",
            environment_root / "home" / ".cac.json",
        ):
            try:
                config_copy.unlink(missing_ok=True)
            except OSError:
                pass


def run_session(
    prepared_dir: Path,
    case: Dict[str, Any],
    paths: Dict[str, Path],
    turn: Dict[str, Any],
    agent_bin: str,
    memory_mode: str,
    timeout_sec: int,
    plugin_dir: Optional[Path] = None,
    openviking_identity: Optional[Dict[str, str]] = None,
    openviking_debug: bool = True,
) -> SessionRunResult:
    """Run one prepared benchmark session as an independent CLI process."""
    session = int(turn["session"])
    harness = paths["harness"]
    workspace = paths["workspace"]
    memory = paths["memory"]
    logs = harness / "logs"
    metrics = harness / "metrics"
    snapshots = harness / "snapshots"
    environment_root = harness / "session_envs" / f"session_{session}"
    case_dir = prepared_dir / "cases" / case["scenario_id"]
    turns_file = case_dir / turn["file"]

    stream_log = logs / f"session_{session}.stream.jsonl"
    stderr_log = logs / f"session_{session}.stderr"
    result_json = logs / f"session_{session}.result.json"
    token_metrics_json = metrics / f"session_{session}.tokens.json"
    diff_path = snapshots / f"session_{session}.diff"
    workspace_delta = snapshots / f"session_{session}_workspace_delta"
    memory_snapshot = snapshots / f"session_{session}_memory"
    openviking_snapshot = snapshots / f"session_{session}_openviking"

    cmd = build_agent_command(agent_bin, memory_mode, memory, plugin_dir=plugin_dir)
    workspace_before = tree_file_hashes(workspace)
    start = time.monotonic()
    exit_code = run_agent_process(
        cmd,
        turns_file,
        stream_log,
        stderr_log,
        workspace,
        environment_root,
        timeout_sec,
        openviking_identity=openviking_identity,
        openviking_debug=openviking_debug,
    )
    duration_sec = time.monotonic() - start

    result = extract_final_result(stream_log)
    if result is not None:
        write_json(result_json, result)
        token_metrics = TokenMetrics.from_result(result).to_dict()
        write_json(token_metrics_json, token_metrics)
    else:
        token_metrics = TokenMetrics().to_dict()

    files_changed = capture_git_diff(workspace, diff_path)
    snapshot_workspace_delta(workspace, workspace_before, workspace_delta)
    snapshot_directory(memory, memory_snapshot)
    openviking_snapshot_path = snapshot_openviking(
        harness,
        openviking_snapshot,
        openviking_identity,
        session_id=(result or {}).get("session_id"),
        search_query=f"{case.get('scenario_id')} session {session}",
        local_environment_root=environment_root,
    )

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
        workspace_delta=str(workspace_delta.relative_to(harness)),
        environment_root=str(environment_root.relative_to(harness)),
        memory_snapshot=str(memory_snapshot.relative_to(harness)),
        memory_diff=None,
        openviking_snapshot=str(openviking_snapshot_path.relative_to(harness)) if openviking_snapshot_path else None,
        openviking_identity=openviking_identity,
        files_changed=files_changed,
    )


def _case_scoring_reference(prepared_dir: Path, case: Dict[str, Any]) -> Dict[str, Any]:
    scenario_id = str(case.get("scenario_id") or "")
    path = prepared_dir / "cases" / scenario_id / "scoring_reference.json"
    if not path.exists():
        return {}
    try:
        return read_json(path)
    except (OSError, json.JSONDecodeError):
        return {}




def _extract_makefile_test_target(text: str) -> str:
    lines = text.splitlines()
    target_lines: List[str] = []
    in_target = False
    for line in lines:
        if re.match(r"^test\s*:", line):
            in_target = True
            target_lines.append(line)
            continue
        if in_target:
            if line.startswith("\t") or line.startswith(" ") or not line.strip():
                target_lines.append(line)
                continue
            break
    return "\n".join(target_lines).strip()


def _check_test_integrity(paths: Dict[str, Path], test_plan: Dict[str, Any]) -> Dict[str, Any]:
    integrity = test_plan.get("integrity") if isinstance(test_plan.get("integrity"), dict) else {}
    if not integrity or integrity.get("status") == "not_checked":
        return {"status": "not_checked", "reason": integrity.get("reason") or "no integrity metadata configured"}

    workspace = paths["workspace"]
    missing_files = []
    for rel in integrity.get("original_test_files") or []:
        if rel and not (workspace / str(rel)).exists():
            missing_files.append(str(rel))
    if missing_files:
        return {
            "status": "failed",
            "reason": "original_test_files_removed",
            "missing_files": missing_files[:10],
        }

    makefile_rel = integrity.get("makefile_path")
    required_patterns = [str(item) for item in integrity.get("required_patterns") or [] if str(item).strip()]
    if makefile_rel and required_patterns:
        makefile = workspace / str(makefile_rel)
        try:
            target = _extract_makefile_test_target(makefile.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            return {"status": "failed", "reason": "original_makefile_missing", "makefile_path": str(makefile_rel)}
        missing_patterns = [pattern for pattern in required_patterns if pattern not in target]
        if missing_patterns:
            return {
                "status": "failed",
                "reason": "original_test_runner_removed_or_narrowed",
                "missing_patterns": missing_patterns[:10],
                "makefile_path": str(makefile_rel),
            }
        return {"status": "passed", "reason": None, "checked_patterns": required_patterns}

    if integrity.get("status") == "basic":
        return {"status": "passed", "reason": None, "checked_files": integrity.get("original_test_files") or []}
    return {"status": "not_checked", "reason": "no executable integrity checks configured"}


def _classify_test_failure(stdout: str, stderr: str, exit_code: Optional[int], executor: str) -> Dict[str, Any]:
    text = f"{stdout}\n{stderr}"
    lower = text.lower()

    if executor == "docker" and (
        "cannot connect to the docker daemon" in lower
        or "docker daemon" in lower
        or "docker.sock" in lower
        or "permission denied while trying to connect to the docker daemon" in lower
    ):
        return {"environment_status": "docker_unavailable", "failure_classification": "docker_unavailable", "missing_dependency": None}
    if executor == "docker" and any(token in lower for token in ("unable to find image", "pull access denied", "repository does not exist")):
        return {"environment_status": "docker_image_unavailable", "failure_classification": "docker_image_unavailable", "missing_dependency": None}

    missing_header = re.search(r"fatal error:\s*([^:\s]+\.h):\s*No such file or directory", text)
    if missing_header:
        return {
            "environment_status": "missing_system_dependency",
            "failure_classification": "missing_system_dependency",
            "missing_dependency": missing_header.group(1),
        }

    pkg_config_missing = re.search(r"(?:No package ['\"]([^'\"]+)['\"] found|Package ['\"]([^'\"]+)['\"].*?was not found)", text, flags=re.IGNORECASE | re.DOTALL)
    if pkg_config_missing:
        return {
            "environment_status": "missing_system_dependency",
            "failure_classification": "missing_system_dependency",
            "missing_dependency": pkg_config_missing.group(1) or pkg_config_missing.group(2),
        }

    make_missing = re.search(r"Missing dependency:\s*([^\"\n]+)", text, flags=re.IGNORECASE)
    if make_missing:
        return {
            "environment_status": "missing_system_dependency",
            "failure_classification": "missing_system_dependency",
            "missing_dependency": make_missing.group(1).strip(),
        }

    missing_cmake_package = re.search(r"Could not find a package configuration file provided by\s+['\"]?([^\s'\"]+)", text, flags=re.IGNORECASE)
    if missing_cmake_package:
        return {
            "environment_status": "missing_system_dependency",
            "failure_classification": "missing_system_dependency",
            "missing_dependency": missing_cmake_package.group(1),
        }

    if (
        "could not resolve host" in lower
        or "failed to clone repository" in lower
        or ("fetchcontent" in lower and "download" in lower)
        or "proxy.golang.org" in lower
        or "registry.npmjs.org" in lower
        or "npm err! network" in lower
        or "eai_again" in lower
        or "enotfound" in lower
        or ("lookup " in lower and "no such host" in lower)
        or "dial tcp" in lower and ("i/o timeout" in lower or "network is unreachable" in lower)
    ):
        return {
            "environment_status": "missing_system_dependency",
            "failure_classification": "network_dependency_unavailable",
            "missing_dependency": "network_fetch_dependency",
        }

    if "no tests found, exiting with code 1" in lower and "jest" in lower:
        return {
            "environment_status": "not_configured",
            "failure_classification": "test_plan_no_tests_found",
            "missing_dependency": None,
        }

    if (
        "add_subdirectory given source \"test\" which is not an existing directory" in lower
        or "doxyfile.in does not exist" in lower
        or "chronoflowconfig.cmake.in does not exist" in lower
    ):
        return {
            "environment_status": "not_configured",
            "failure_classification": "test_plan_missing_project_files",
            "missing_dependency": None,
        }

    if "parse error" in lower and "got unquoted argument" in lower and "```" in text:
        return {
            "environment_status": "not_configured",
            "failure_classification": "malformed_test_fixture",
            "missing_dependency": None,
        }

    mhd_api_mismatch = any(
        token in text
        for token in (
            "MHD_USE_SIGNAL_PIPE",
            "MHD_QUEUE",
            "MHD_AccessHandlerCallback",
        )
    ) or "mhd_st" in lower or "mhd_connection_value_remote_address" in lower or "mhd_option_host" in lower
    likely_generated_code_error = any(
        token in lower
        for token in (
            "log_level_warn",
            "ratelimiter_t' has no member",
            "has no member named",
            "previous declaration of",
        )
    )
    if mhd_api_mismatch and not likely_generated_code_error:
        return {
            "environment_status": "missing_system_dependency",
            "failure_classification": "incompatible_system_dependency",
            "missing_dependency": "libmicrohttpd_api",
        }

    if "parse error" in lower or "cmake generate step failed" in lower or "cmake error" in lower:
        return {"environment_status": "ready", "failure_classification": "test_failed", "missing_dependency": None}

    exec_missing = re.search(r"exec:\s*['\"]([^'\"]+)['\"]:\s*executable file not found", text, flags=re.IGNORECASE)
    shell_missing = re.search(r"(?:^|\n)(?:(?:/bin/)?(?:ba)?sh:\s*(?:\d+:\s*)?)?([^\s:]+):\s*(?:command not found|not found)", text, flags=re.IGNORECASE)
    if exec_missing or "command not found" in lower or (("no such file or directory" in lower or shell_missing) and exit_code in {126, 127}):
        return {
            "environment_status": "missing_command",
            "failure_classification": "missing_command",
            "missing_dependency": (exec_missing.group(1) if exec_missing else (shell_missing.group(1) if shell_missing else None)),
        }

    if exit_code == 0:
        return {"environment_status": "ready", "failure_classification": None, "missing_dependency": None}
    return {"environment_status": "ready", "failure_classification": "test_failed", "missing_dependency": None}



def _docker_preflight_command(docker_image: str, docker_network: str) -> List[str]:
    script = r"""
set -eu
check_cmd() { command -v "$1" >/dev/null 2>&1 && printf 'cmd:%s=ok\n' "$1" || printf 'cmd:%s=missing\n' "$1"; }
check_header() { printf '#include <%s>\nint main(void){return 0;}\n' "$1" | cc -x c - -o /tmp/preflight-check >/dev/null 2>&1 && printf 'header:%s=ok\n' "$1" || printf 'header:%s=missing\n' "$1"; }
check_pkg() { pkg-config --exists "$1" >/dev/null 2>&1 && printf 'pkg:%s=ok\n' "$1" || printf 'pkg:%s=missing\n' "$1"; }
for cmd in cc gcc g++ clang make cmake ctest pkg-config node npm jest vitest mocha cross-env python3 go git bash doxygen; do check_cmd "$cmd"; done
for header in microhttpd.h jansson.h json-c/json.h cjson/cJSON.h sqlite3.h uuid/uuid.h curl/curl.h openssl/ssl.h uthash.h postgresql/libpq-fe.h hiredis/hiredis.h uv.h sodium.h zmq.h librdkafka/rdkafka.h SDL2/SDL.h SDL2/SDL_image.h SDL2/SDL_mixer.h google/protobuf-c/protobuf-c.h grpc/grpc.h graphqlparser/c/GraphQLParser.h cairo/cairo.h maxminddb.h mosquitto.h zstd.h oniguruma.h fftw3.h sndfile.h portaudio.h png.h rocksdb/c.h nats/nats.h libmemcached/memcached.h; do check_header "$header"; done
for pkg in libmicrohttpd jansson json-c libcjson sqlite3 uuid libcurl openssl libpq hiredis libevent libpcre2-8 zlib libuv libsodium libzmq rdkafka yaml-cpp glib-2.0 gio-2.0 json-glib-1.0 gtk+-3.0 gtk4 sdl2 SDL2_image SDL2_mixer protobuf libprotobuf-c grpc check cmocka criterion graphqlparser libgraphqlparser cairo fftw3 libbson-1.0 libmaxminddb libmosquitto libsoup-3.0 libxml-2.0 libzstd oniguruma opencv4 sndfile portaudio-2.0 libpng libjpeg openblas lapack glfw3 nlohmann_json fmt spdlog libmemcached; do check_pkg "$pkg"; done
""".strip()
    return [
        "docker",
        "run",
        "--rm",
        "--network",
        docker_network,
        docker_image,
        "sh",
        "-lc",
        script,
    ]


def run_docker_preflight(docker_image: str, output_path: Path, docker_network: str = "none", timeout_sec: int = 120) -> Dict[str, Any]:
    """Probe a Docker image for common memory-eval post-run test dependencies."""
    start = time.time()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        completed = subprocess.run(
            _docker_preflight_command(docker_image, docker_network),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_sec,
            check=False,
        )
        checks: Dict[str, Dict[str, str]] = {"cmd": {}, "header": {}, "pkg": {}}
        for line in completed.stdout.splitlines():
            match = re.match(r"^(cmd|header|pkg):([^=]+)=(ok|missing)$", line.strip())
            if match:
                checks[match.group(1)][match.group(2)] = match.group(3)
        missing = {
            group: sorted(name for name, status in values.items() if status != "ok")
            for group, values in checks.items()
        }
        result = {
            "status": "passed" if completed.returncode == 0 else "failed",
            "docker_image": docker_image,
            "docker_network": docker_network,
            "exit_code": completed.returncode,
            "duration_sec": round(time.time() - start, 3),
            "checks": checks,
            "missing": missing,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
        }
    except subprocess.TimeoutExpired as exc:
        result = {
            "status": "timeout",
            "docker_image": docker_image,
            "docker_network": docker_network,
            "exit_code": None,
            "duration_sec": round(time.time() - start, 3),
            "checks": {"cmd": {}, "header": {}, "pkg": {}},
            "missing": {},
            "stdout": exc.stdout or "",
            "stderr": exc.stderr or "",
        }
    except OSError as exc:
        result = {
            "status": "docker_unavailable",
            "docker_image": docker_image,
            "docker_network": docker_network,
            "exit_code": None,
            "duration_sec": round(time.time() - start, 3),
            "checks": {"cmd": {}, "header": {}, "pkg": {}},
            "missing": {},
            "stdout": "",
            "stderr": str(exc),
        }
    write_json(output_path, result)
    return result


def _docker_command(
    workspace: Path,
    working_dir: str,
    command: List[str],
    docker_image: str,
    docker_network: str,
) -> List[str]:
    container_workdir = "/workspace" if working_dir in {"", "."} else f"/workspace/{working_dir.strip('/')}"
    return [
        "docker",
        "run",
        "--rm",
        "--network",
        docker_network,
        "--cpus",
        "2",
        "--memory",
        "4g",
        "-v",
        f"{workspace.resolve()}:/workspace",
        "-w",
        container_workdir,
        docker_image,
        *[str(item) for item in command],
    ]


def _test_result_base(test_plan: Dict[str, Any], command: List[Any], executor: str, docker_image: Optional[str], docker_network: str) -> Dict[str, Any]:
    return {
        "command": [str(item) for item in command],
        "working_dir": str(test_plan.get("working_dir") or "."),
        "source": test_plan.get("source"),
        "test_plan_status": str(test_plan.get("status") or ""),
        "executor": executor,
        "docker_image": docker_image if executor == "docker" else None,
        "docker_network": docker_network if executor == "docker" else None,
    }


def run_post_run_tests(
    prepared_dir: Path,
    case: Dict[str, Any],
    paths: Dict[str, Path],
    session_results: List[SessionRunResult],
    test_executor: Optional[str] = None,
    docker_image: Optional[str] = None,
    docker_network: str = "none",
) -> Dict[str, Any]:
    """Run the prepared final-workspace test plan and persist normalized evidence."""
    harness = paths["harness"]
    logs = harness / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    stdout_path = logs / "post_run_tests.stdout"
    stderr_path = logs / "post_run_tests.stderr"
    result_path = harness / "test_result.json"
    reference = _case_scoring_reference(prepared_dir, case)
    test_plan = reference.get("test_plan") if isinstance(reference, dict) else None
    if not isinstance(test_plan, dict):
        result = {
            "status": "skipped",
            "reason": "no test_plan in scoring_reference.json",
            "command": [],
            "working_dir": ".",
            "source": None,
            "environment_status": "not_configured",
            "integrity_status": "not_checked",
        }
        write_json(result_path, result)
        return result

    plan_status = str(test_plan.get("status") or "")
    command = test_plan.get("command") or []
    executor = str(test_executor or test_plan.get("executor") or "host").strip().lower()
    if executor not in {"host", "docker"}:
        executor = "host"
    selected_docker_image = docker_image or test_plan.get("docker_image") or "locobench-memory-eval:base"
    if plan_status != "configured" or not isinstance(command, list) or not command:
        result = {
            **_test_result_base(test_plan, command if isinstance(command, list) else [], executor, selected_docker_image, docker_network),
            "status": "skipped",
            "reason": test_plan.get("reason") or f"test_plan status is {plan_status or 'unknown'}",
            "environment_status": "not_configured",
            "integrity_status": "not_checked",
        }
        write_json(result_path, result)
        return result

    if any(session.is_error for session in session_results):
        result = {
            **_test_result_base(test_plan, command, executor, selected_docker_image, docker_network),
            "status": "skipped",
            "reason": "case has error sessions; final workspace tests not run",
            "environment_status": "not_run",
            "integrity_status": "not_checked",
        }
        write_json(result_path, result)
        return result

    integrity = _check_test_integrity(paths, test_plan)
    docker_preflight_path = harness / "docker_preflight.json"
    docker_preflight = None
    if executor == "docker":
        docker_preflight = run_docker_preflight(str(selected_docker_image), docker_preflight_path, docker_network=docker_network)
    working_dir = paths["workspace"] / str(test_plan.get("working_dir") or ".")
    timeout_sec = int(test_plan.get("timeout_sec") or 300)
    run_command = (
        _docker_command(paths["workspace"], str(test_plan.get("working_dir") or "."), [str(item) for item in command], str(selected_docker_image), docker_network)
        if executor == "docker"
        else [str(item) for item in command]
    )
    cwd = paths["workspace"] if executor == "docker" else (working_dir if working_dir.exists() else paths["workspace"])
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
            **_test_result_base(test_plan, command, executor, selected_docker_image, docker_network),
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
        stdout_text = exc.stdout or ""
        stderr_text = exc.stderr or ""
        stdout_path.write_text(stdout_text, encoding="utf-8", errors="replace")
        stderr_path.write_text(stderr_text, encoding="utf-8", errors="replace")
        result = {
            **_test_result_base(test_plan, command, executor, selected_docker_image, docker_network),
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
    except OSError as exc:
        environment_status = "docker_unavailable" if executor == "docker" else "missing_command"
        result = {
            **_test_result_base(test_plan, command, executor, selected_docker_image, docker_network),
            "status": "skipped",
            "exit_code": None,
            "duration_sec": round(time.time() - start, 3),
            "stdout": None,
            "stderr": None,
            "reason": f"could not execute test command: {exc}",
            "environment_status": environment_status,
            "failure_classification": environment_status,
            "missing_dependency": None,
            "integrity_status": str(integrity.get("status") or "not_checked"),
            "integrity_reason": integrity.get("reason"),
            "integrity": integrity,
            "docker_preflight": str(docker_preflight_path.relative_to(harness)) if docker_preflight is not None else None,
            "docker_preflight_status": docker_preflight.get("status") if isinstance(docker_preflight, dict) else None,
        }
    write_json(result_path, result)
    return result


def build_case_result(
    case: Dict[str, Any],
    memory_mode: str,
    agent_bin: str,
    paths: Dict[str, Path],
    session_results: List[SessionRunResult],
    errors: Optional[List[str]] = None,
    plugin_dir: Optional[Path] = None,
    openviking_identity: Optional[Dict[str, str]] = None,
    test_result: Optional[Dict[str, Any]] = None,
    memory_settle_sec: Optional[float] = None,
    run_namespace: Optional[str] = None,
    prepared_provenance: Optional[Dict[str, Any]] = None,
) -> CaseRunResult:
    """Build a case-level result object."""
    harness = paths["harness"]
    final_diff = harness / "snapshots" / "final.diff"
    capture_git_diff(paths["workspace"], final_diff)
    final_memory = harness / "snapshots" / "final_memory"
    snapshot_directory(paths["memory"], final_memory)
    final_openviking = harness / "snapshots" / "final_openviking"
    last_environment_root = None
    if session_results and session_results[-1].environment_root:
        last_environment_root = harness / session_results[-1].environment_root
    final_openviking_snapshot = snapshot_openviking(
        harness,
        final_openviking,
        openviking_identity,
        session_id=(session_results[-1].session_id if session_results else None),
        search_query=str(case.get("scenario_id") or case.get("case_id") or "memory eval"),
        local_environment_root=last_environment_root,
    )
    return CaseRunResult(
        scenario_id=case["scenario_id"],
        case_id=case["case_id"],
        variant=variant_for_memory_mode(memory_mode),
        run_environment={
            "agent_bin": agent_bin,
            "memory_mode": memory_mode,
            "memory_backend": memory_backend_for_mode(memory_mode),
            "memory_settle_sec": memory_settle_sec,
            "run_namespace": run_namespace,
            "plugin_dir": str(plugin_dir.resolve()) if plugin_dir else None,
            "session_environment_pattern": str(harness / "session_envs" / "session_{session}"),
            "home_isolation": "per_session",
            "prepared_dataset_sha256": (prepared_provenance or {}).get("prepared_dataset_sha256"),
            "prepared_case_sha256": (prepared_provenance or {}).get("prepared_case_sha256"),
        },
        sessions=session_results,
        final_diff=str(final_diff.relative_to(harness)),
        final_memory_snapshot=str(final_memory.relative_to(harness)),
        final_openviking_snapshot=str(final_openviking_snapshot.relative_to(harness)) if final_openviking_snapshot else None,
        prepared_snapshot="prepared_snapshot/case" if prepared_provenance else None,
        prepared_provenance="prepared_snapshot/provenance.json" if prepared_provenance else None,
        test_result=test_result,
        memory_backend=memory_backend_for_mode(memory_mode),
        openviking_identity=openviking_identity,
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
    plugin_dir: Optional[Path] = None,
    openviking_url: str = DEFAULT_OPENVIKING_URL,
    openviking_account: str = DEFAULT_OPENVIKING_ACCOUNT,
    openviking_user_prefix: Optional[str] = None,
    openviking_peer_prefix: Optional[str] = None,
    openviking_debug: bool = True,
    test_executor: Optional[str] = None,
    docker_image: Optional[str] = None,
    docker_network: str = "none",
    run_namespace: Optional[str] = None,
) -> Dict[str, Any]:
    """Run a single case/session smoke test."""
    prepared_dir = prepared_dir.resolve()
    output_dir = output_dir.resolve()
    run_lock = _acquire_output_lock(output_dir)
    variant = variant_for_memory_mode(memory_mode)
    run_namespace = _initialize_run_namespace(
        output_dir,
        resume=False,
        requested=run_namespace,
        variant=variant,
        prepared_dir=prepared_dir,
    )
    case = select_case(prepared_dir, scenario_id)
    matching_turns = [turn for turn in case.get("turns", []) if int(turn.get("session", 0)) == session]
    if not matching_turns:
        raise ValueError(f"Session {session} not found for {case['scenario_id']}")

    paths = setup_workspace_at(case, output_dir)
    prepared_provenance = snapshot_prepared_inputs(prepared_dir, case, paths["harness"])
    identity = build_openviking_identity(
        memory_mode,
        case,
        openviking_url=openviking_url,
        openviking_account=openviking_account,
        openviking_user_prefix=openviking_user_prefix,
        openviking_peer_prefix=openviking_peer_prefix,
        run_namespace=run_namespace,
    )

    result = run_session(
        prepared_dir,
        case,
        paths,
        matching_turns[0],
        agent_bin,
        memory_mode,
        timeout_sec,
        plugin_dir=plugin_dir,
        openviking_identity=identity,
        openviking_debug=openviking_debug,
    )
    test_result = run_post_run_tests(
        prepared_dir,
        case,
        paths,
        [result],
        test_executor=test_executor,
        docker_image=docker_image,
        docker_network=docker_network,
    )
    case_result = build_case_result(
        case,
        memory_mode,
        agent_bin,
        paths,
        [result],
        plugin_dir=plugin_dir,
        openviking_identity=identity,
        test_result=test_result,
        memory_settle_sec=None,
        run_namespace=run_namespace,
        prepared_provenance=prepared_provenance,
    )
    write_json(paths["harness"] / "result.json", case_result.to_dict())
    permission_denials_count = len(result.permission_denials or [])
    status = "pass" if result.exit_code == 0 and not result.is_error and permission_denials_count == 0 else "fail"
    summary = {
        "status": status,
        "agent_bin": agent_bin,
        "memory_mode": memory_mode,
        "memory_backend": memory_backend_for_mode(memory_mode),
        "variant": variant_for_memory_mode(memory_mode),
        "run_namespace": run_namespace,
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
        "openviking_identity": identity,
        "openviking_snapshot": result.openviking_snapshot,
        "duration_ms": result.token_metrics.get("duration_ms", 0),
    }
    write_json(paths["harness"] / "smoke_result.json", summary)
    run_lock.close()
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
    plugin_dir: Optional[Path] = None,
    openviking_url: str = DEFAULT_OPENVIKING_URL,
    openviking_account: str = DEFAULT_OPENVIKING_ACCOUNT,
    openviking_user_prefix: Optional[str] = None,
    openviking_peer_prefix: Optional[str] = None,
    openviking_debug: bool = True,
    test_executor: Optional[str] = None,
    docker_image: Optional[str] = None,
    docker_network: str = "none",
    memory_settle_sec: float = DEFAULT_MEMORY_SETTLE_SEC,
    run_namespace: Optional[str] = None,
) -> Dict[str, Any]:
    """Run prepared memory eval cases for one variant."""
    prepared_dir = prepared_dir.resolve()
    output_dir = output_dir.resolve()
    run_lock = _acquire_output_lock(output_dir)
    cases = load_manifest(prepared_dir)
    if scenario_id:
        cases = [case for case in cases if case.get("scenario_id") == scenario_id]
    if limit:
        cases = cases[:limit]
    variant = variant_for_memory_mode(memory_mode)
    _validate_case_output_isolation(cases, output_dir, resume, expected_variant=variant)
    run_namespace = _initialize_run_namespace(
        output_dir,
        resume=resume,
        requested=run_namespace,
        variant=variant,
        prepared_dir=prepared_dir,
    )

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
            prepared_provenance = snapshot_prepared_inputs(prepared_dir, case, paths["harness"])
            identity = build_openviking_identity(
                memory_mode,
                case,
                openviking_url=openviking_url,
                openviking_account=openviking_account,
                openviking_user_prefix=openviking_user_prefix,
                openviking_peer_prefix=openviking_peer_prefix,
                run_namespace=run_namespace,
            )
            session_results = []
            for turn_index, turn in enumerate(turns):
                session = int(turn["session"])
                report(f"Starting session {session} for {scenario}")
                session_result = run_session(
                    prepared_dir,
                    case,
                    paths,
                    turn,
                    agent_bin,
                    memory_mode,
                    timeout_sec,
                    plugin_dir=plugin_dir,
                    openviking_identity=identity,
                    openviking_debug=openviking_debug,
                )
                session_results.append(session_result)
                status = "error" if session_result.is_error else "success"
                report(f"Finished session {session} for {scenario}: {status} in {session_result.duration_sec:.1f}s")
                if turn_index < len(turns) - 1 and should_settle_memory(memory_mode, memory_settle_sec):
                    settle_result = settle_memory_between_sessions(memory_mode, memory_settle_sec)
                    session_result.memory_settle = settle_result
                    report(
                        f"Memory settle after session {session} for {scenario}: "
                        f"slept {settle_result['duration_sec']:.1f}s"
                    )
            test_result = run_post_run_tests(
                prepared_dir,
                case,
                paths,
                session_results,
                test_executor=test_executor,
                docker_image=docker_image,
                docker_network=docker_network,
            )
            case_result = build_case_result(
                case,
                memory_mode,
                agent_bin,
                paths,
                session_results,
                plugin_dir=plugin_dir,
                openviking_identity=identity,
                test_result=test_result,
                memory_settle_sec=memory_settle_sec,
                run_namespace=run_namespace,
                prepared_provenance=prepared_provenance,
            )
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
            identity = build_openviking_identity(
                memory_mode,
                case,
                openviking_url=openviking_url,
                openviking_account=openviking_account,
                openviking_user_prefix=openviking_user_prefix,
                openviking_peer_prefix=openviking_peer_prefix,
                run_namespace=run_namespace,
            )
            write_json(error_dir / "result.json", {
                "scenario_id": case.get("scenario_id"),
                "case_id": case.get("case_id"),
                "variant": variant_for_memory_mode(memory_mode),
                "memory_backend": memory_backend_for_mode(memory_mode),
                "openviking_identity": identity,
                "run_environment": {
                    "agent_bin": agent_bin,
                    "memory_mode": memory_mode,
                    "memory_backend": memory_backend_for_mode(memory_mode),
                    "memory_settle_sec": memory_settle_sec,
                    "run_namespace": run_namespace,
                    "plugin_dir": str(plugin_dir.resolve()) if plugin_dir else None,
                },
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
        "memory_backend": memory_backend_for_mode(memory_mode),
        "variant": variant_for_memory_mode(memory_mode),
        "run_namespace": run_namespace,
        "plugin_dir": str(plugin_dir.resolve()) if plugin_dir else None,
        "openviking_url": openviking_url if is_openviking_mode(memory_mode) else None,
        "openviking_account": openviking_account if is_openviking_mode(memory_mode) else None,
        "openviking_user_prefix": openviking_user_prefix if is_openviking_mode(memory_mode) else None,
        "openviking_peer_prefix": openviking_peer_prefix if is_openviking_mode(memory_mode) else None,
        "memory_settle_sec": memory_settle_sec,
    }
    write_json(output_dir / "run_summary.json", summary)
    report(f"Run summary: completed={completed} failed={failed} skipped={skipped} total={len(cases)}")
    run_lock.close()
    return summary
