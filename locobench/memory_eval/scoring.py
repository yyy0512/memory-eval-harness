"""Scoring and reporting for memory eval runs."""

import hashlib
import json
import shlex
import subprocess
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from .io import read_json, write_json

SCHEMA_VERSION = "memory_eval_scoring_v3"
MEMORY_METRIC_VARIANTS = {"memory_on"}
JUNK_SUFFIXES = {".tmp", ".temp", ".swp", ".swo", ".pyc", ".log"}
JUNK_NAMES = {".DS_Store", "Thumbs.db", "__pycache__"}
LLM_SCORE_KEYS = ("task_completion", "fix_correctness", "output_quality", "overall")
DEFAULT_JUDGE_COMMAND = [
    "codeagentcli",
    "--dangerously-skip-permissions",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
]


Metric = Dict[str, Any]


def collect_case_results(run_dir: Path) -> List[Dict[str, Any]]:
    """Read all case-level result.json files in a run directory."""
    results = []
    for result_path in sorted(run_dir.glob("*/harness/result.json")):
        result = read_json(result_path)
        result["_result_path"] = str(result_path)
        result["_harness_dir"] = str(result_path.parent)
        results.append(result)
    return results


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _safe_float(value: Any) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _token_value(session: Dict[str, Any], key: str) -> int:
    usage = session.get("usage") or {}
    token_metrics = session.get("token_metrics") or {}
    if key in usage:
        return _safe_int(usage.get(key))
    return _safe_int(token_metrics.get(key))


def _session_token_metrics(session: Dict[str, Any]) -> Dict[str, Any]:
    input_tokens = _token_value(session, "input_tokens")
    output_tokens = _token_value(session, "output_tokens")
    cache_creation = _token_value(session, "cache_creation_input_tokens")
    cache_read = _token_value(session, "cache_read_input_tokens")
    token_metrics = session.get("token_metrics") or {}
    new_tokens = _safe_int(token_metrics.get("new_input_output_tokens")) or input_tokens + output_tokens
    total_reported = (
        _safe_int(token_metrics.get("total_reported_tokens"))
        or input_tokens + output_tokens + cache_creation + cache_read
    )
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_creation_input_tokens": cache_creation,
        "cache_read_input_tokens": cache_read,
        "new_input_output_tokens": new_tokens,
        "total_reported_tokens": total_reported,
        "total_cost_usd": _safe_float(session.get("total_cost_usd")),
        "duration_ms": _safe_int(token_metrics.get("duration_ms")),
        "duration_api_ms": _safe_int(token_metrics.get("duration_api_ms")),
        "duration_sec": _safe_float(session.get("duration_sec")),
    }


def _sum_token_totals(sessions: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    totals: Dict[str, Any] = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "new_input_output_tokens": 0,
        "total_reported_tokens": 0,
        "total_cost_usd": 0.0,
        "duration_ms": 0,
        "duration_api_ms": 0,
        "duration_sec": 0.0,
    }
    for session in sessions:
        metrics = _session_token_metrics(session)
        for key, value in metrics.items():
            totals[key] += value
    return totals


def _metric(score: Optional[float], status: str, confidence: float, evidence: List[str]) -> Metric:
    return {
        "score": score,
        "status": status,
        "confidence": round(confidence, 4),
        "evidence": evidence,
    }


def _status_from_score(score: Optional[float]) -> str:
    if score is None:
        return "not_applicable"
    if score >= 0.8:
        return "pass"
    if score >= 0.4:
        return "partial"
    return "fail"


def _harness_dir(case: Dict[str, Any]) -> Optional[Path]:
    raw = case.get("_harness_dir")
    return Path(raw) if raw else None


def _resolve_harness_path(case: Dict[str, Any], relative_path: Optional[str]) -> Optional[Path]:
    if not relative_path:
        return None
    path = Path(relative_path)
    if path.is_absolute():
        return path
    harness = _harness_dir(case)
    if harness is None:
        return None
    return harness / path


def _file_set_from_snapshot(snapshot: Optional[Path]) -> List[str]:
    if snapshot is None or not snapshot.exists() or not snapshot.is_dir():
        return []
    return sorted(path.relative_to(snapshot).as_posix() for path in snapshot.rglob("*") if path.is_file())


def _overlap_ratio(left: Iterable[str], right: Iterable[str]) -> Optional[float]:
    left_set = set(left)
    right_set = set(right)
    if not left_set and not right_set:
        return None
    union = left_set | right_set
    if not union:
        return None
    return len(left_set & right_set) / len(union)


def _is_text_file(path: Path) -> Tuple[bool, str]:
    try:
        data = path.read_bytes()
    except OSError:
        return False, ""
    if b"\0" in data[:4096]:
        return False, ""
    try:
        return True, data.decode("utf-8")
    except UnicodeDecodeError:
        return False, ""


def _memory_snapshot_summary(snapshot: Optional[Path]) -> Dict[str, Any]:
    files = []
    text_files = 0
    binary_files = 0
    junk_files = 0
    empty_files = 0
    structured_files = 0
    total_bytes = 0
    if snapshot is not None and snapshot.exists() and snapshot.is_dir():
        for path in sorted(p for p in snapshot.rglob("*") if p.is_file()):
            rel = path.relative_to(snapshot).as_posix()
            files.append(rel)
            name_parts = set(path.parts)
            if path.name in JUNK_NAMES or name_parts & JUNK_NAMES or path.suffix in JUNK_SUFFIXES:
                junk_files += 1
            try:
                size = path.stat().st_size
            except OSError:
                size = 0
            total_bytes += size
            if size == 0:
                empty_files += 1
            is_text, text = _is_text_file(path)
            if is_text:
                text_files += 1
                lines = [line.strip() for line in text.splitlines() if line.strip()]
                if any(line.startswith(("#", "-", "*")) or ":" in line for line in lines):
                    structured_files += 1
            else:
                binary_files += 1
    return {
        "exists": bool(snapshot is not None and snapshot.exists() and snapshot.is_dir()),
        "file_count": len(files),
        "files": files,
        "text_files": text_files,
        "binary_files": binary_files,
        "junk_files": junk_files,
        "empty_files": empty_files,
        "structured_files": structured_files,
        "total_bytes": total_bytes,
    }


def _truncate_text(text: str, max_chars: int) -> str:
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    return text[:max_chars] + f"\n...[truncated {len(text) - max_chars} chars]"


def _read_text_excerpt(path: Optional[Path], max_chars: int) -> str:
    if path is None or not path.exists() or not path.is_file():
        return ""
    try:
        return _truncate_text(path.read_text(encoding="utf-8", errors="replace"), max_chars)
    except OSError:
        return ""


def _reference_path(prepared_dir: Optional[Path], scenario_id: str) -> Optional[Path]:
    if prepared_dir is None:
        return None
    return prepared_dir / "cases" / scenario_id / "scoring_reference.json"


def _raw_case_reference(prepared_dir: Optional[Path], scenario_id: str) -> Optional[Dict[str, Any]]:
    reference_path = _reference_path(prepared_dir, scenario_id)
    if reference_path is None or not reference_path.exists():
        return None
    return read_json(reference_path)


def _case_reference(prepared_dir: Optional[Path], scenario_id: str) -> Dict[str, Any]:
    reference = _raw_case_reference(prepared_dir, scenario_id)
    if reference is None:
        return {"present": False, "fingerprint": None}
    encoded = json.dumps(reference, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return {
        "present": True,
        "fingerprint": f"sha256:{hashlib.sha256(encoded).hexdigest()}",
    }


def _is_clean_success_session(session: Dict[str, Any]) -> bool:
    """Return true when a session completed cleanly from the CLI perspective."""
    return (
        session.get("cli_result_json") is not None
        and session.get("exit_code") == 0
        and session.get("subtype") == "success"
        and not session.get("is_error")
        and not session.get("errors")
    )


def _is_memory_save_permission_denial(denial: Any) -> bool:
    """Return true for permission denials caused by memory-save attempts."""
    text = json.dumps(denial, ensure_ascii=False, sort_keys=True).lower()
    return "session_memory" in text or "session memory" in text or (".cac" in text and "memory" in text)


def _has_only_nonfatal_memory_off_memory_denials(session: Dict[str, Any], variant: Optional[str]) -> bool:
    """Return true for clean memory_off sessions with only memory-save permission denials."""
    denials = session.get("permission_denials") or []
    return (
        variant == "memory_off"
        and _is_clean_success_session(session)
        and bool(denials)
        and all(_is_memory_save_permission_denial(denial) for denial in denials)
    )


def classify_session_failures(
    session: Dict[str, Any],
    variant: Optional[str] = None,
    ignore_nonfatal_memory_denials: bool = False,
) -> List[str]:
    """Return deterministic failure reason codes for a session result."""
    reason_codes = []
    exit_code = session.get("exit_code")
    if session.get("cli_result_json") is None:
        reason_codes.append("no_result_event")
    if exit_code == 124:
        reason_codes.append("timeout")
    elif exit_code not in (None, 0):
        reason_codes.append("nonzero_exit")
    if session.get("is_error"):
        reason_codes.append("is_error_flag")
    if session.get("permission_denials") and not (
        ignore_nonfatal_memory_denials and _has_only_nonfatal_memory_off_memory_denials(session, variant)
    ):
        reason_codes.append("permission_denied")
    if session.get("errors"):
        reason_codes.append("session_error")
    return reason_codes


def _case_failure_profile(case: Dict[str, Any], variant: str) -> Dict[str, Any]:
    by_reason: Dict[str, int] = {}
    sessions = []
    case_reason_codes = []
    if case.get("errors"):
        case_reason_codes.append("case_error")
        by_reason["case_error"] = by_reason.get("case_error", 0) + len(case.get("errors") or [])
    for session in case.get("sessions", []):
        reason_codes = classify_session_failures(session)
        for reason in reason_codes:
            by_reason[reason] = by_reason.get(reason, 0) + 1
        if reason_codes:
            sessions.append(
                {
                    "variant": variant,
                    "scenario_id": case.get("scenario_id"),
                    "case_id": case.get("case_id"),
                    "session": session.get("session"),
                    "reason_codes": reason_codes,
                }
            )
    return {
        "reason_codes": sorted(set(case_reason_codes + [reason for session in sessions for reason in session["reason_codes"]])),
        "by_reason": by_reason,
        "sessions": sessions,
    }


def _relaxed_session_failures(session: Dict[str, Any], variant: str) -> List[str]:
    """Return failure reasons with non-fatal memory_off memory-save denials ignored."""
    return classify_session_failures(session, variant=variant, ignore_nonfatal_memory_denials=True)


def score_final_task_completion(case: Dict[str, Any], variant: str) -> Metric:
    """Score final task completion with deterministic execution outcome proxies."""
    sessions = sorted(case.get("sessions", []), key=lambda item: item.get("session") or 0)
    evidence = []
    if not sessions:
        return _metric(0.0, "fail", 1.0, ["no sessions recorded"])

    final_session = sessions[-1]
    final_failures = _relaxed_session_failures(final_session, variant)
    all_failures = [failure for session in sessions for failure in _relaxed_session_failures(session, variant)]
    ignored_denials = [
        session
        for session in sessions
        if session.get("permission_denials") and _has_only_nonfatal_memory_off_memory_denials(session, variant)
    ]
    if case.get("errors"):
        evidence.append("case-level errors recorded")
    if final_failures:
        evidence.append(f"final session failure reasons: {', '.join(final_failures)}")
    if ignored_denials:
        evidence.append("non-fatal memory-save permission denials ignored for memory_off task completion")
    if final_failures or case.get("errors"):
        return _metric(0.0, "fail", 1.0, evidence or ["final session did not complete cleanly"])
    if all_failures:
        evidence.append("final session succeeded after earlier recoverable failures")
        return _metric(0.5, "partial", 0.9, evidence)
    evidence.append("all sessions completed without recorded errors")
    return _metric(1.0, "pass", 1.0, evidence)


def score_cross_session_continuity(case: Dict[str, Any], variant: str) -> Metric:
    """Score continuity across sessions using changed-file and memory snapshot proxies."""
    sessions = sorted(case.get("sessions", []), key=lambda item: item.get("session") or 0)
    if len(sessions) < 2:
        return _metric(None, "not_applicable", 0.0, ["fewer than two sessions"])

    evidence = []
    file_sets = [set(session.get("files_changed") or []) for session in sessions]
    file_overlaps = []
    for left, right in zip(file_sets, file_sets[1:]):
        ratio = _overlap_ratio(left, right)
        if ratio is not None:
            file_overlaps.append(ratio)
    avg_file_overlap = sum(file_overlaps) / len(file_overlaps) if file_overlaps else 0.0
    evidence.append(f"average changed-file overlap: {avg_file_overlap:.2f}")

    score = 0.25
    if avg_file_overlap >= 0.5:
        score = 0.75
    elif avg_file_overlap >= 0.2:
        score = 0.5
    elif any(file_sets):
        score = 0.35

    if variant in MEMORY_METRIC_VARIANTS:
        snapshot_sets = []
        for session in sessions:
            snapshot_sets.append(_file_set_from_snapshot(_resolve_harness_path(case, session.get("memory_snapshot"))))
        non_empty_snapshots = sum(1 for files in snapshot_sets if files)
        snapshot_overlaps = []
        for left, right in zip(snapshot_sets, snapshot_sets[1:]):
            ratio = _overlap_ratio(left, right)
            if ratio is not None:
                snapshot_overlaps.append(ratio)
        avg_snapshot_overlap = sum(snapshot_overlaps) / len(snapshot_overlaps) if snapshot_overlaps else 0.0
        evidence.append(f"non-empty memory snapshots: {non_empty_snapshots}/{len(sessions)}")
        evidence.append(f"average memory snapshot overlap: {avg_snapshot_overlap:.2f}")
        if non_empty_snapshots >= len(sessions) - 1 and avg_snapshot_overlap >= 0.5:
            score += 0.25
        elif non_empty_snapshots:
            score += 0.1

    score = min(1.0, score)
    return _metric(round(score, 4), _status_from_score(score), 0.75, evidence)


def score_memory_write_quality(case: Dict[str, Any], variant: str) -> Metric:
    """Score whether memory snapshots contain useful, structured text memory."""
    if variant not in MEMORY_METRIC_VARIANTS:
        return _metric(None, "not_applicable", 0.0, ["memory writing is disabled for this variant"])

    snapshot = _resolve_harness_path(case, case.get("final_memory_snapshot"))
    summary = _memory_snapshot_summary(snapshot)
    if not summary["exists"] or summary["file_count"] == 0:
        return _metric(0.0, "fail", 1.0, ["final memory snapshot is empty or missing"])

    score = 0.2
    evidence = [f"memory files: {summary['file_count']}"]
    text_ratio = summary["text_files"] / summary["file_count"] if summary["file_count"] else 0.0
    structured_ratio = summary["structured_files"] / summary["text_files"] if summary["text_files"] else 0.0
    if text_ratio >= 0.8:
        score += 0.25
        evidence.append(f"text file ratio: {text_ratio:.2f}")
    if structured_ratio >= 0.5:
        score += 0.25
        evidence.append(f"structured text ratio: {structured_ratio:.2f}")
    if summary["junk_files"] == 0 and summary["binary_files"] == 0:
        score += 0.2
        evidence.append("no junk or binary memory files detected")
    if 0 < summary["total_bytes"] <= 200_000:
        score += 0.1
        evidence.append(f"memory size is concise: {summary['total_bytes']} bytes")
    if summary["empty_files"]:
        score -= 0.1
        evidence.append(f"empty memory files: {summary['empty_files']}")
    if summary["junk_files"]:
        score -= 0.2
        evidence.append(f"junk memory files: {summary['junk_files']}")
    score = max(0.0, min(1.0, score))
    return _metric(round(score, 4), _status_from_score(score), 0.8, evidence)


def score_memory_usage_evidence(case: Dict[str, Any], variant: str) -> Metric:
    """Score proxy evidence that later sessions could use persisted memory."""
    if variant not in MEMORY_METRIC_VARIANTS:
        return _metric(None, "not_applicable", 0.0, ["memory usage is disabled for this variant"])

    sessions = sorted(case.get("sessions", []), key=lambda item: item.get("session") or 0)
    if len(sessions) < 2:
        return _metric(None, "not_applicable", 0.0, ["fewer than two sessions"])

    snapshot_sets = [
        _file_set_from_snapshot(_resolve_harness_path(case, session.get("memory_snapshot"))) for session in sessions
    ]
    later_non_empty = sum(1 for files in snapshot_sets[1:] if files)
    overlap_ratios = []
    for left, right in zip(snapshot_sets, snapshot_sets[1:]):
        ratio = _overlap_ratio(left, right)
        if ratio is not None:
            overlap_ratios.append(ratio)
    avg_overlap = sum(overlap_ratios) / len(overlap_ratios) if overlap_ratios else 0.0
    later_successes = sum(
        1 for session in sessions[1:] if not _relaxed_session_failures(session, variant) and session.get("exit_code") == 0
    )

    evidence = [
        f"later non-empty memory snapshots: {later_non_empty}/{len(sessions) - 1}",
        f"average memory carry-forward overlap: {avg_overlap:.2f}",
        f"later successful sessions: {later_successes}/{len(sessions) - 1}",
    ]
    score = 0.0
    if later_non_empty:
        score += 0.35
    if avg_overlap >= 0.5:
        score += 0.35
    elif avg_overlap > 0:
        score += 0.2
    if later_successes == len(sessions) - 1:
        score += 0.3
    elif later_successes:
        score += 0.15
    confidence = 0.65 if later_non_empty else 0.5
    score = max(0.0, min(1.0, score))
    return _metric(round(score, 4), _status_from_score(score), confidence, evidence)


def _reference_strings(reference: Optional[Dict[str, Any]]) -> List[str]:
    strings: List[str] = []

    def collect(value: Any) -> None:
        if isinstance(value, str) and len(value) >= 5:
            strings.append(value)
        elif isinstance(value, dict):
            for child in value.values():
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)

    collect(reference or {})
    return sorted(set(strings), key=len, reverse=True)


def _redact_reference_text(text: str, reference: Optional[Dict[str, Any]]) -> str:
    redacted = text
    for secret in _reference_strings(reference):
        redacted = redacted.replace(secret, "[redacted reference]")
    return redacted


def _safe_judge_string(value: Any, reference: Optional[Dict[str, Any]], max_chars: int = 1000) -> str:
    text = str(value or "")
    return _truncate_text(_redact_reference_text(text, reference), max_chars)


def _normalise_judge_config(llm_judge: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not llm_judge or not llm_judge.get("enabled"):
        return None
    command = llm_judge.get("command") or DEFAULT_JUDGE_COMMAND
    if isinstance(command, str):
        command = shlex.split(command)
    return {
        "enabled": True,
        "command": list(command),
        "timeout_sec": _safe_int(llm_judge.get("timeout_sec")) or 300,
        "max_chars": _safe_int(llm_judge.get("max_chars")) or 12000,
        "model": llm_judge.get("model") or "external-command",
    }


def _memory_text_excerpts(snapshot: Optional[Path], max_chars: int) -> Dict[str, str]:
    excerpts: Dict[str, str] = {}
    if snapshot is None or not snapshot.exists() or not snapshot.is_dir():
        return excerpts
    remaining = max_chars
    for path in sorted(p for p in snapshot.rglob("*") if p.is_file()):
        if remaining <= 0:
            break
        is_text, text = _is_text_file(path)
        if not is_text:
            continue
        rel = path.relative_to(snapshot).as_posix()
        excerpt = _truncate_text(text, min(remaining, 2000))
        excerpts[rel] = excerpt
        remaining -= len(excerpt)
    return excerpts


def _build_llm_judge_prompt(
    case: Dict[str, Any],
    variant: str,
    prepared_dir: Optional[Path],
    max_chars: int,
) -> Tuple[Optional[str], Optional[Dict[str, Any]], Optional[str]]:
    scenario_id = str(case.get("scenario_id") or case.get("case_id") or "")
    reference = _raw_case_reference(prepared_dir, scenario_id)
    if reference is None:
        return None, None, "missing scoring_reference.json"

    final_diff = _read_text_excerpt(_resolve_harness_path(case, case.get("final_diff")), max_chars // 2)
    final_memory_path = _resolve_harness_path(case, case.get("final_memory_snapshot"))
    memory_summary = _memory_snapshot_summary(final_memory_path)
    memory_excerpts = _memory_text_excerpts(final_memory_path, max(0, max_chars // 4)) if variant in MEMORY_METRIC_VARIANTS else {}
    sessions = []
    for session in sorted(case.get("sessions", []), key=lambda item: item.get("session") or 0):
        sessions.append(
            {
                "session": session.get("session"),
                "exit_code": session.get("exit_code"),
                "is_error": session.get("is_error"),
                "failure_reasons": _relaxed_session_failures(session, variant),
                "files_changed": session.get("files_changed") or [],
                "duration_sec": session.get("duration_sec"),
            }
        )
    payload = {
        "scenario_id": scenario_id,
        "case_id": case.get("case_id"),
        "variant": variant,
        "sessions": sessions,
        "case_errors": case.get("errors") or [],
        "final_diff_excerpt": final_diff,
        "memory_summary": memory_summary,
        "memory_excerpts": memory_excerpts,
        "confidential_scoring_reference": reference,
    }
    prompt = f"""You are an evaluator for a LoCoBench multi-session coding benchmark run.

Use the confidential scoring reference to judge whether the agent completed the intended task. Do not quote or reveal any confidential reference text in your response.

Return ONLY a JSON object with this exact shape:
{{
  "scores": {{
    "task_completion": 0.0,
    "fix_correctness": 0.0,
    "output_quality": 0.0,
    "overall": 0.0
  }},
  "rationale": "one concise non-confidential explanation",
  "evidence": ["short non-confidential evidence item"]
}}

Scores must be numbers from 0 to 1. Judge strictly: execution success alone is insufficient if the diff does not satisfy the reference.

Evaluation payload:
{json.dumps(payload, ensure_ascii=False, indent=2)}
"""
    return _truncate_text(prompt, max_chars), reference, None


def _extract_json_object(text: str) -> Dict[str, Any]:
    stripped = text.strip()
    if not stripped:
        raise ValueError("empty judge output")
    try:
        parsed = json.loads(stripped)
        if isinstance(parsed, dict) and ("scores" in parsed or any(key in parsed for key in LLM_SCORE_KEYS)):
            return parsed
    except json.JSONDecodeError:
        pass

    last_result_text = None
    for line in stripped.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        for key in ("result", "content", "text"):
            if isinstance(event.get(key), str):
                last_result_text = event[key]
        message = event.get("message")
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str):
                last_result_text = content
            elif isinstance(content, list):
                text_parts = [item.get("text") for item in content if isinstance(item, dict) and isinstance(item.get("text"), str)]
                if text_parts:
                    last_result_text = "\n".join(text_parts)
    if last_result_text:
        return _extract_json_object(last_result_text)

    start = stripped.find("{")
    end = stripped.rfind("}")
    if start != -1 and end != -1 and end > start:
        parsed = json.loads(stripped[start : end + 1])
        if isinstance(parsed, dict):
            return parsed
    raise ValueError("judge output did not contain a JSON object")


def _clamp_score(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return round(max(0.0, min(1.0, number)), 4)


def _normalise_judge_payload(payload: Dict[str, Any], reference: Optional[Dict[str, Any]], model: str) -> Dict[str, Any]:
    raw_scores = payload.get("scores") if isinstance(payload.get("scores"), dict) else payload
    scores = {key: _clamp_score(raw_scores.get(key)) for key in LLM_SCORE_KEYS}
    if scores["overall"] is None:
        numeric = [score for score in scores.values() if score is not None]
        scores["overall"] = round(sum(numeric) / len(numeric), 4) if numeric else None
    overall = scores.get("overall")
    status = "judge_error" if overall is None else _status_from_score(overall)
    evidence_value = payload.get("evidence") or []
    if not isinstance(evidence_value, list):
        evidence_value = [evidence_value]
    return {
        "enabled": True,
        "status": status,
        "model": payload.get("model") or model,
        "scores": scores,
        "rationale": _safe_judge_string(payload.get("rationale"), reference, 1000),
        "evidence": [_safe_judge_string(item, reference, 300) for item in evidence_value[:5]],
        "error": None if status != "judge_error" else "missing numeric judge scores",
    }


def score_llm_judge(
    case: Dict[str, Any],
    variant: str,
    prepared_dir: Optional[Path],
    llm_judge: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """Run an optional external LLM judge for one case and return safe report fields."""
    config = _normalise_judge_config(llm_judge)
    if config is None:
        return {"enabled": False, "status": "not_applicable"}
    prompt, reference, prompt_error = _build_llm_judge_prompt(case, variant, prepared_dir, config["max_chars"])
    if prompt_error or prompt is None:
        return {
            "enabled": True,
            "status": "not_applicable",
            "model": config["model"],
            "scores": {key: None for key in LLM_SCORE_KEYS},
            "rationale": "",
            "evidence": [],
            "error": prompt_error,
        }
    try:
        completed = subprocess.run(
            config["command"],
            input=prompt,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=config["timeout_sec"],
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {
            "enabled": True,
            "status": "judge_error",
            "model": config["model"],
            "scores": {key: None for key in LLM_SCORE_KEYS},
            "rationale": "",
            "evidence": [],
            "error": _safe_judge_string(type(exc).__name__, reference, 200),
        }
    if completed.returncode != 0:
        return {
            "enabled": True,
            "status": "judge_error",
            "model": config["model"],
            "scores": {key: None for key in LLM_SCORE_KEYS},
            "rationale": "",
            "evidence": [],
            "error": f"judge command exited with code {completed.returncode}",
        }
    try:
        payload = _extract_json_object(completed.stdout)
        return _normalise_judge_payload(payload, reference, config["model"])
    except (json.JSONDecodeError, ValueError, TypeError) as exc:
        return {
            "enabled": True,
            "status": "judge_error",
            "model": config["model"],
            "scores": {key: None for key in LLM_SCORE_KEYS},
            "rationale": "",
            "evidence": [],
            "error": _safe_judge_string(str(exc), reference, 300),
        }


def score_case(
    case: Dict[str, Any],
    variant: str,
    prepared_dir: Optional[Path] = None,
    llm_judge: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Compute deterministic and optional LLM judge scores for one case result."""
    scenario_id = str(case.get("scenario_id") or case.get("case_id") or "")
    case_id = str(case.get("case_id") or scenario_id)
    failure_profile = _case_failure_profile(case, variant)
    result_path = case.get("_result_path")
    scored = {
        "scenario_id": scenario_id,
        "case_id": case_id,
        "variant": variant,
        "reference": _case_reference(prepared_dir, scenario_id),
        "metrics": {
            "final_task_completion": score_final_task_completion(case, variant),
            "cross_session_continuity": score_cross_session_continuity(case, variant),
            "memory_write_quality": score_memory_write_quality(case, variant),
            "memory_usage_evidence": score_memory_usage_evidence(case, variant),
        },
        "failure_profile": {"reason_codes": failure_profile["reason_codes"]},
        "artifacts": {
            "result_json": str(result_path) if result_path else None,
            "final_diff": case.get("final_diff"),
            "final_memory_snapshot": case.get("final_memory_snapshot"),
        },
    }
    judge_result = score_llm_judge(case, variant, prepared_dir, llm_judge)
    if judge_result.get("enabled"):
        scored["llm_judge"] = judge_result
    return scored


def _aggregate_metric(case_scores: List[Dict[str, Any]], metric_name: str) -> Dict[str, Any]:
    metrics = [case["metrics"][metric_name] for case in case_scores]
    numeric = [metric for metric in metrics if metric.get("score") is not None]
    result = {
        "mean": round(sum(metric["score"] for metric in numeric) / len(numeric), 4) if numeric else None,
        "confidence_mean": round(sum(metric.get("confidence") or 0.0 for metric in numeric) / len(numeric), 4)
        if numeric
        else 0.0,
        "pass_count": sum(1 for metric in metrics if metric.get("status") == "pass"),
        "partial_count": sum(1 for metric in metrics if metric.get("status") == "partial"),
        "fail_count": sum(1 for metric in metrics if metric.get("status") == "fail"),
        "not_applicable_count": sum(1 for metric in metrics if metric.get("status") == "not_applicable"),
    }
    return result


def _aggregate_llm_metrics(case_scores: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    judge_results = [case.get("llm_judge") for case in case_scores if (case.get("llm_judge") or {}).get("enabled")]
    if not judge_results:
        return None
    aggregate: Dict[str, Any] = {}
    for key in LLM_SCORE_KEYS:
        values = [judge["scores"].get(key) for judge in judge_results if (judge.get("scores") or {}).get(key) is not None]
        aggregate[key] = {
            "mean": round(sum(values) / len(values), 4) if values else None,
            "count": len(values),
        }
    aggregate["judge_error_count"] = sum(1 for judge in judge_results if judge.get("status") == "judge_error")
    aggregate["not_applicable_count"] = sum(1 for judge in judge_results if judge.get("status") == "not_applicable")
    return aggregate


def _aggregate_failure_profiles(cases: List[Dict[str, Any]], variant: str) -> Dict[str, Any]:
    by_reason: Dict[str, int] = {}
    sessions = []
    for case in cases:
        profile = _case_failure_profile(case, variant)
        for reason, count in profile["by_reason"].items():
            by_reason[reason] = by_reason.get(reason, 0) + count
        sessions.extend(profile["sessions"])
    return {"by_reason": by_reason, "sessions": sessions}


def summarize_variant(
    run_dir: Path,
    prepared_dir: Optional[Path] = None,
    llm_judge: Optional[Dict[str, Any]] = None,
    case_results: Optional[List[Dict[str, Any]]] = None,
    case_scores: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Summarize token/cost/duration, quality metrics, error profile, and optional LLM judge scores."""
    cases = case_results if case_results is not None else collect_case_results(run_dir)
    variant = run_dir.name
    sessions = [session for case in cases for session in case.get("sessions", [])]
    error_sessions = [session for session in sessions if session.get("is_error") or session.get("exit_code") != 0]
    token_totals = _sum_token_totals(sessions)
    if case_scores is None:
        case_scores = [score_case(case, variant, prepared_dir, llm_judge) for case in cases]
    summary = {
        "run_dir": str(run_dir),
        "case_count": len(cases),
        "session_count": len(sessions),
        "error_session_count": len(error_sessions),
        "token_totals": token_totals,
        "metrics": {
            "final_task_completion": _aggregate_metric(case_scores, "final_task_completion"),
            "cross_session_continuity": _aggregate_metric(case_scores, "cross_session_continuity"),
            "memory_write_quality": _aggregate_metric(case_scores, "memory_write_quality"),
            "memory_usage_evidence": _aggregate_metric(case_scores, "memory_usage_evidence"),
        },
        "failure_profile": _aggregate_failure_profiles(cases, variant),
    }
    llm_metrics = _aggregate_llm_metrics(case_scores)
    if llm_metrics is not None:
        summary["llm_metrics"] = llm_metrics
    return summary


def _delta(off_tokens: Dict[str, Any], on_tokens: Dict[str, Any], key: str) -> Any:
    return off_tokens.get(key, 0) - on_tokens.get(key, 0)


def _metric_delta(memory_on: Dict[str, Any], memory_off: Dict[str, Any], metric_name: str) -> Optional[float]:
    on_value = ((memory_on.get("metrics") or {}).get(metric_name) or {}).get("mean")
    off_value = ((memory_off.get("metrics") or {}).get(metric_name) or {}).get("mean")
    if on_value is None or off_value is None:
        return None
    return round(off_value - on_value, 4)


def _llm_metric_delta(memory_on: Dict[str, Any], memory_off: Dict[str, Any], metric_name: str) -> Optional[float]:
    on_value = ((memory_on.get("llm_metrics") or {}).get(metric_name) or {}).get("mean")
    off_value = ((memory_off.get("llm_metrics") or {}).get(metric_name) or {}).get("mean")
    if on_value is None or off_value is None:
        return None
    return round(off_value - on_value, 4)


def compute_deltas(memory_on: Optional[Dict[str, Any]], memory_off: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Compute memory_off - memory_on efficiency and metric deltas."""
    if not memory_on or not memory_off:
        return {}
    on_tokens = memory_on["token_totals"]
    off_tokens = memory_off["token_totals"]
    deltas = {
        "input_token_delta": _delta(off_tokens, on_tokens, "input_tokens"),
        "output_token_delta": _delta(off_tokens, on_tokens, "output_tokens"),
        "cache_creation_input_token_delta": _delta(off_tokens, on_tokens, "cache_creation_input_tokens"),
        "cache_read_input_token_delta": _delta(off_tokens, on_tokens, "cache_read_input_tokens"),
        "new_input_output_token_delta": _delta(off_tokens, on_tokens, "new_input_output_tokens"),
        "total_reported_token_delta": _delta(off_tokens, on_tokens, "total_reported_tokens"),
        "cost_delta_usd": _delta(off_tokens, on_tokens, "total_cost_usd"),
        "duration_delta_ms": _delta(off_tokens, on_tokens, "duration_ms"),
        "duration_api_delta_ms": _delta(off_tokens, on_tokens, "duration_api_ms"),
        "duration_sec_delta": _delta(off_tokens, on_tokens, "duration_sec"),
        "final_task_completion_delta": _metric_delta(memory_on, memory_off, "final_task_completion"),
        "cross_session_continuity_delta": _metric_delta(memory_on, memory_off, "cross_session_continuity"),
        "memory_write_quality_delta": _metric_delta(memory_on, memory_off, "memory_write_quality"),
        "memory_usage_evidence_delta": _metric_delta(memory_on, memory_off, "memory_usage_evidence"),
    }
    if memory_on.get("llm_metrics") or memory_off.get("llm_metrics"):
        deltas.update(
            {
                "llm_task_completion_delta": _llm_metric_delta(memory_on, memory_off, "task_completion"),
                "llm_fix_correctness_delta": _llm_metric_delta(memory_on, memory_off, "fix_correctness"),
                "llm_output_quality_delta": _llm_metric_delta(memory_on, memory_off, "output_quality"),
                "llm_overall_delta": _llm_metric_delta(memory_on, memory_off, "overall"),
            }
        )
    return deltas


def score_runs(
    run_dirs: List[Path],
    output: Path,
    prepared_dir: Optional[Path] = None,
    llm_judge: Optional[Dict[str, Any]] = None,
    progress: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    """Score one or more variant run directories and write JSON/Markdown reports."""
    prepared_dir = prepared_dir.resolve() if prepared_dir is not None else None
    llm_judge = _normalise_judge_config(llm_judge)
    variants = {}
    cases = []
    for run_dir in run_dirs:
        variant = run_dir.name
        if progress:
            progress(f"Scoring variant {variant}: collecting cases")
        case_results = collect_case_results(run_dir)
        if progress:
            progress(f"Scoring variant {variant}: {len(case_results)} case(s)")
        case_scores = []
        for index, case in enumerate(case_results, start=1):
            scenario_id = case.get("scenario_id") or case.get("case_id") or "unknown"
            if progress:
                progress(f"Scoring variant {variant}: case {index}/{len(case_results)} {scenario_id}")
            case_scores.append(score_case(case, variant, prepared_dir, llm_judge))
        variants[variant] = summarize_variant(run_dir, prepared_dir, llm_judge, case_results, case_scores)
        cases.extend(case_scores)
    report = {
        "schema_version": SCHEMA_VERSION,
        "prepared_dir": str(prepared_dir) if prepared_dir else None,
        "llm_judge_enabled": bool(llm_judge),
        "variants": variants,
        "cases": cases,
        "deltas": compute_deltas(variants.get("memory_on"), variants.get("memory_off")),
    }
    if progress:
        progress(f"Writing report to {output}")
    write_json(output, report)
    markdown = output.with_suffix(".md")
    markdown.parent.mkdir(parents=True, exist_ok=True)
    markdown.write_text(render_markdown_report(report), encoding="utf-8")
    return report


def _zh_metric_name(metric_name: str) -> str:
    names = {
        "final_task_completion": "最终任务完成度",
        "cross_session_continuity": "跨 session 连续性",
        "memory_write_quality": "Memory 写入质量",
        "memory_usage_evidence": "Memory 使用证据",
        "task_completion": "任务完成度",
        "fix_correctness": "修复正确性",
        "output_quality": "输出质量",
        "overall": "总体评分",
    }
    return names.get(metric_name, metric_name)


def render_markdown_report(report: Dict[str, Any]) -> str:
    """Render a compact human-readable Chinese memory eval report."""
    lines = ["# Memory Eval 评测报告", "", f"Schema 版本：`{report.get('schema_version', 'unknown')}`", ""]
    lines.append("说明：差异值统一按 `memory_off - memory_on` 计算；质量指标为负数通常表示 memory_on 更好。")
    lines.append("")
    for name, summary in report["variants"].items():
        token_totals = summary["token_totals"]
        lines.append(f"## 变体：{name}")
        lines.append(f"- Case 数：{summary['case_count']}")
        lines.append(f"- Session 数：{summary['session_count']}")
        lines.append(f"- 异常 session 数：{summary['error_session_count']}")
        lines.append(f"- Input tokens：{token_totals['input_tokens']}")
        lines.append(f"- Output tokens：{token_totals['output_tokens']}")
        lines.append(f"- Cache creation tokens：{token_totals['cache_creation_input_tokens']}")
        lines.append(f"- Cache read tokens：{token_totals['cache_read_input_tokens']}")
        lines.append(f"- 总成本 USD：{token_totals['total_cost_usd']}")
        lines.append(f"- 总耗时秒数：{token_totals['duration_sec']}")
        lines.append("- 确定性质量指标：")
        for metric_name, aggregate in (summary.get("metrics") or {}).items():
            lines.append(
                f"  - {_zh_metric_name(metric_name)} (`{metric_name}`)：mean={aggregate.get('mean')}，"
                f"通过={aggregate.get('pass_count')}，部分={aggregate.get('partial_count')}，"
                f"失败={aggregate.get('fail_count')}，不适用={aggregate.get('not_applicable_count')}"
            )
        failure_profile = summary.get("failure_profile") or {}
        if failure_profile.get("by_reason"):
            lines.append(f"- 失败原因统计：{failure_profile['by_reason']}")
        llm_metrics = summary.get("llm_metrics") or {}
        if llm_metrics:
            lines.append("- LLM judge 质量指标：")
            for metric_name in LLM_SCORE_KEYS:
                aggregate = llm_metrics.get(metric_name) or {}
                lines.append(
                    f"  - {_zh_metric_name(metric_name)} (`{metric_name}`)："
                    f"mean={aggregate.get('mean')}，count={aggregate.get('count')}"
                )
            lines.append(f"  - judge 错误数：{llm_metrics.get('judge_error_count', 0)}")
        lines.append("")
    if report.get("deltas"):
        lines.append("## 差异（memory_off - memory_on）")
        for key, value in report["deltas"].items():
            lines.append(f"- `{key}`：{value}")
        lines.append("")
    return "\n".join(lines)
