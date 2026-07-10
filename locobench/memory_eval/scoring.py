"""Scoring and reporting for memory eval runs."""

import fnmatch
import hashlib
import json
import re
import shlex
import subprocess
from collections import Counter
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from .io import read_json, sha256_prepared_case, sha256_prepared_dataset, write_json

SCHEMA_VERSION = "memory_eval_scoring_v10_session_contracts"
MEMORY_METRIC_VARIANTS = {"memory_on", "native_memory_on", "openviking_on"}
OPENVIKING_VARIANTS = {"openviking_on"}
CORE_DETERMINISTIC_METRICS = (
    "contract_compliance",
    "test_runnable_rate",
    "test_pass_rate",
    "requirement_rule_coverage",
    "memory_content_quality",
)
OPENVIKING_HEALTH_KEYS = (
    "capture_state",
    "recall_state",
    "context_injection_state",
    "isolation_state",
)
TOKEN_COMPARISON_KEYS = (
    "input_tokens",
    "output_tokens",
    "new_input_output_tokens",
    "total_reported_tokens",
    "total_cost_usd",
    "duration_sec",
)
TOOL_COMPARISON_KEYS = (
    "tool_call_count",
    "search_or_read_tool_call_count",
    "bash_tool_call_count",
    "edit_tool_call_count",
    "memory_tool_call_count",
)
JUNK_SUFFIXES = {".tmp", ".temp", ".swp", ".swo", ".pyc", ".log"}
JUNK_NAMES = {".DS_Store", "Thumbs.db", "__pycache__"}
PAIRWISE_VERDICTS = {"A_better", "B_better", "tie", "both_bad", "judge_uncertain"}
DEFAULT_JUDGE_COMMAND = [
    "codeagentcli",
    "--dangerously-skip-permissions",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
]

METRIC_DEFINITIONS = [
    {
        "id": "contract_compliance",
        "zh_name": "Contract 遵从率",
        "scope": "核心质量",
        "definition": "检查 session 1 引入、后续不重复的固定 contract suite 是否在每个发生相关文件变化的后续 session 中得到遵守；不把 session 1 已落盘并被动保留的内容算作记忆效果。",
        "formula": "每个 check 先计算 passing_applicable_sessions / applicable_sessions，再在 contract 内平均，最后对可评分 contract 等权平均；最终 workspace 状态作为独立 evidence 展示。",
        "method": "规则",
    },
    {
        "id": "test_runnable_rate",
        "zh_name": "测试可运行率",
        "scope": "核心质量",
        "definition": "衡量最终 workspace 的 post-run test 是否真正可执行且 test target/integrity 可信；用于和测试通过率分开解读，避免把测试环境/计划不可用误读为代码质量失败。",
        "formula": "environment_status=ready 且 integrity_status!=failed 且 runtime test status 不是 skipped/timeout/invalid 时记 1；否则 N/A/0 在聚合覆盖率中体现。",
        "method": "规则",
    },
    {
        "id": "test_pass_rate",
        "zh_name": "可运行测试通过率",
        "scope": "核心质量",
        "definition": "在可运行且 integrity 可信的 post-run test 中，最终 workspace 是否通过测试；应结合 test_runnable_rate 一起看。",
        "formula": "对 test_runnable_rate 可运行的 case：post-run test exit_code == 0 ? 1 : 0；测试计划/环境不可用或测试目标被弱化时 N/A。",
        "method": "规则",
    },
    {
        "id": "requirement_rule_coverage",
        "zh_name": "需求规则覆盖率",
        "scope": "核心质量",
        "definition": "用 evaluator-owned deterministic requirement checks 检查 case 本身任务要求是否满足；只有显式 evaluator overlay checks 生成 numeric score。",
        "formula": "passed_requirement_checks / total_requirement_checks；未配置显式 evaluator checks 的 case 为 N/A。",
        "method": "规则",
    },
    {
        "id": "memory_content_quality",
        "zh_name": "Memory 内容质量",
        "scope": "核心质量",
        "definition": "检查 memory backend 是否记录应该被记住的关键事实，例如 session 1 contract、架构决策、接口约定和后续 TODO。",
        "formula": "matched_expected_memory_facts / total_expected_memory_facts；memory_off 为 N/A。",
        "method": "规则为主",
    },
    {
        "id": "blind_llm_pairwise",
        "zh_name": "Blind LLM 胜率",
        "scope": "辅助判断",
        "definition": "对同一个 case 的两个匿名 submission 做 blind pairwise judge，并交换 A/B 位置复判；真实 variant 只在聚合阶段恢复。",
        "formula": "(wins + 0.5 * ties) / judged_pairs；both_bad 和 uncertain 单独统计。",
        "method": "LLM",
    },
    {
        "id": "efficiency",
        "zh_name": "效率指标",
        "scope": "辅助效率",
        "definition": "统计 token、成本、耗时和 tool calls，用于分析 memory backend 是否减少重复探索或额外成本。",
        "formula": "candidate - baseline，并给出相对 baseline 的百分比；质量 delta > 0 更好，效率 delta < 0 更省或更快。",
        "method": "规则",
    },
    {
        "id": "openviking_backend_health",
        "zh_name": "OpenViking backend health",
        "scope": "Debug evidence",
        "definition": "只在启用 openviking_on 时展示 capture / recall / context injection / isolation 状态，用于解释 backend 是否接好。",
        "formula": "pass / partial / fail + evidence；不参与核心质量均值或主结论。",
        "method": "规则",
    },
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


def _read_json_file(path: Optional[Path]) -> Optional[Dict[str, Any]]:
    if path is None or not path.exists() or not path.is_file():
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {"value": data}
    except (OSError, json.JSONDecodeError):
        return None


def _reference_path(prepared_dir: Optional[Path], scenario_id: str) -> Optional[Path]:
    if prepared_dir is None:
        return None
    return prepared_dir / "cases" / scenario_id / "scoring_reference.json"


def _raw_case_reference(prepared_dir: Optional[Path], scenario_id: str) -> Optional[Dict[str, Any]]:
    reference_path = _reference_path(prepared_dir, scenario_id)
    if reference_path is None or not reference_path.exists():
        return None
    return read_json(reference_path)


def _validate_case_provenance(
    case: Dict[str, Any],
    prepared_dir: Optional[Path] = None,
    current_dataset_hash: Optional[str] = None,
) -> Dict[str, Any]:
    provenance_path = _resolve_harness_path(case, case.get("prepared_provenance"))
    snapshot_dir = _resolve_harness_path(case, case.get("prepared_snapshot"))
    if provenance_path is None or snapshot_dir is None or not provenance_path.is_file() or not snapshot_dir.is_dir():
        return {"status": "missing", "verified": False, "reason": "run has no embedded prepared provenance"}
    try:
        provenance = read_json(provenance_path)
        snapshot_hash = sha256_prepared_case(snapshot_dir)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"status": "invalid", "verified": False, "reason": f"could not read provenance: {type(exc).__name__}"}
    if provenance.get("schema_version") != "memory_eval_run_provenance_v1":
        return {"status": "invalid", "verified": False, "reason": "unsupported run provenance schema"}
    expected_case_hash = str(provenance.get("prepared_case_sha256") or "")
    expected_snapshot_hash = str(provenance.get("snapshot_case_sha256") or "")
    expected_dataset_hash = str(provenance.get("prepared_dataset_sha256") or "")
    if not expected_dataset_hash:
        return {"status": "invalid", "verified": False, "reason": "provenance has no prepared dataset hash"}
    if not expected_case_hash or snapshot_hash not in {expected_case_hash, expected_snapshot_hash}:
        return {"status": "mismatch", "verified": False, "reason": "embedded prepared case hash mismatch"}
    scenario_id = str(case.get("scenario_id") or case.get("case_id") or "")
    if str(provenance.get("scenario_id") or "") != scenario_id:
        return {"status": "mismatch", "verified": False, "reason": "provenance scenario_id mismatch"}
    if prepared_dir is not None:
        current_case_dir = prepared_dir / "cases" / scenario_id
        if not current_case_dir.is_dir() or sha256_prepared_case(current_case_dir) != expected_case_hash:
            return {"status": "mismatch", "verified": False, "reason": "current prepared case differs from run snapshot"}
        actual_dataset_hash = current_dataset_hash or sha256_prepared_dataset(prepared_dir)
        if expected_dataset_hash != actual_dataset_hash:
            return {"status": "mismatch", "verified": False, "reason": "current prepared dataset differs from run provenance"}
    return {
        "status": "verified",
        "verified": True,
        "verification_status": provenance.get("verification_status"),
        "prepared_dataset_sha256": provenance.get("prepared_dataset_sha256"),
        "prepared_case_sha256": expected_case_hash,
    }


def _raw_case_reference_for_case(case: Dict[str, Any], prepared_dir: Optional[Path]) -> Optional[Dict[str, Any]]:
    provenance = _validate_case_provenance(case)
    if provenance.get("verified"):
        snapshot_dir = _resolve_harness_path(case, case.get("prepared_snapshot"))
        snapshot_reference = snapshot_dir / "scoring_reference.json" if snapshot_dir is not None else None
        if snapshot_reference is not None and snapshot_reference.is_file():
            return read_json(snapshot_reference)
    scenario_id = str(case.get("scenario_id") or case.get("case_id") or "")
    return _raw_case_reference(prepared_dir, scenario_id)


def _case_reference(case: Dict[str, Any], prepared_dir: Optional[Path]) -> Dict[str, Any]:
    reference = _raw_case_reference_for_case(case, prepared_dir)
    if reference is None:
        return {"present": False, "fingerprint": None}
    encoded = json.dumps(reference, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return {
        "present": True,
        "fingerprint": f"sha256:{hashlib.sha256(encoded).hexdigest()}",
    }


def _normalise_count_key(value: Any) -> str:
    text = str(value or "").strip()
    return text if text else "unknown"


def _increment(counter: Dict[str, int], value: Any) -> None:
    key = _normalise_count_key(value)
    counter[key] = counter.get(key, 0) + 1


def _empty_dataset_stats() -> Dict[str, Any]:
    return {
        "difficulty_distribution": {},
        "task_type_distribution": {},
        "programming_language_distribution": {},
        "contract_stats": {
            "contracts_per_case_distribution": {},
            "contract_id_distribution": {},
            "contract_category_distribution": {},
            "contract_memory_type_distribution": {},
            "workspace_checkable_contracts_per_case_distribution": {},
            "memory_fact_contracts_per_case_distribution": {},
            "case_contracts": [],
        },
        "test_availability_stats": {},
        "test_plan_stats": {},
        "test_environment_stats": {},
        "test_integrity_stats": {},
        "requirement_check_stats": {
            "checks_per_case_distribution": {},
            "status_distribution": {},
            "source_distribution": {},
            "strength_distribution": {},
            "signal_kind_distribution": {},
            "rejection_reason_distribution": {},
            "configured_cases": 0,
            "configured_by_overlay_cases": 0,
            "configured_by_auto_cases": 0,
            "not_configured_cases": 0,
            "case_requirement_checks": [],
        },
    }


def _contract_check_count(contract: Dict[str, Any]) -> int:
    checks = contract.get("checks")
    if not isinstance(checks, list):
        return 0
    return sum(1 for check in checks if isinstance(check, dict))


def _load_dataset_stats(prepared_dir: Optional[Path]) -> Dict[str, Any]:
    if prepared_dir is None:
        return _empty_dataset_stats()
    summary_path = prepared_dir / "summary.json"
    summary = _read_json_file(summary_path) or {}
    stats = summary.get("dataset_stats")
    if isinstance(stats, dict) and any(isinstance(stats.get(key), dict) for key in _empty_dataset_stats()):
        loaded = _empty_dataset_stats()
        for key, default in loaded.items():
            value = stats.get(key)
            if isinstance(default, dict):
                loaded[key] = dict(value or {}) if isinstance(value, dict) else default
            else:
                loaded[key] = value if isinstance(value, list) else default
        contract_stats = loaded.get("contract_stats") or {}
        default_contract_stats = _empty_dataset_stats()["contract_stats"]
        for key, value in default_contract_stats.items():
            if key not in contract_stats:
                contract_stats[key] = value
        loaded["contract_stats"] = contract_stats
        requirement_stats = loaded.get("requirement_check_stats") or {}
        default_requirement_stats = _empty_dataset_stats()["requirement_check_stats"]
        for key, value in default_requirement_stats.items():
            if key not in requirement_stats:
                requirement_stats[key] = value
        loaded["requirement_check_stats"] = requirement_stats
        return loaded

    computed = _empty_dataset_stats()
    manifest_path = prepared_dir / "manifest.jsonl"
    if not manifest_path.exists():
        return computed
    try:
        with manifest_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                scenario_id = str(row.get("scenario_id") or "")
                metadata = _read_json_file(prepared_dir / "cases" / scenario_id / "metadata.json") or {}
                _increment(computed["difficulty_distribution"], metadata.get("difficulty"))
                _increment(computed["task_type_distribution"], row.get("original_task_category"))
                _increment(computed["programming_language_distribution"], row.get("language"))
                reference = _read_json_file(prepared_dir / "cases" / scenario_id / "scoring_reference.json") or {}
                contracts = reference.get("memory_contracts") or []
                if isinstance(contracts, list):
                    _increment(computed["contract_stats"]["contracts_per_case_distribution"], len(contracts))
                    contract_ids = []
                    contract_categories = []
                    contract_memory_types = []
                    workspace_checkable_contract_ids = []
                    memory_fact_ids = {
                        str(fact.get("id") or f"fact_{idx}")
                        for idx, fact in enumerate(reference.get("expected_memory_facts") or [], start=1)
                        if isinstance(fact, dict)
                        and (fact.get("required_keywords") or fact.get("required_regex") or fact.get("forbidden_keywords"))
                    }
                    for index, contract in enumerate(contracts, start=1):
                        if not isinstance(contract, dict):
                            continue
                        contract_id = str(contract.get("id") or f"contract_{index}")
                        contract_category = str(contract.get("category") or contract.get("type") or "uncategorized")
                        memory_type = str(contract.get("memory_type") or "project").strip().lower() or "project"
                        contract_ids.append(contract_id)
                        contract_categories.append(contract_category)
                        contract_memory_types.append(memory_type)
                        if _contract_check_count(contract):
                            workspace_checkable_contract_ids.append(contract_id)
                        _increment(computed["contract_stats"]["contract_id_distribution"], contract_id)
                        _increment(computed["contract_stats"]["contract_category_distribution"], contract_category)
                        _increment(computed["contract_stats"]["contract_memory_type_distribution"], memory_type)
                    _increment(computed["contract_stats"]["workspace_checkable_contracts_per_case_distribution"], len(workspace_checkable_contract_ids))
                    _increment(computed["contract_stats"]["memory_fact_contracts_per_case_distribution"], len(memory_fact_ids))
                    computed["contract_stats"]["case_contracts"].append(
                        {
                            "scenario_id": scenario_id,
                            "case_id": row.get("case_id"),
                            "contract_count": len(contract_ids),
                            "memory_fact_contract_count": len(memory_fact_ids),
                            "workspace_checkable_contract_count": len(workspace_checkable_contract_ids),
                            "contract_ids": contract_ids,
                            "memory_fact_contract_ids": sorted(memory_fact_ids),
                            "workspace_checkable_contract_ids": workspace_checkable_contract_ids,
                            "contract_categories": sorted(set(contract_categories)),
                            "memory_types": sorted(set(contract_memory_types)),
                        }
                    )
    except OSError:
        return _empty_dataset_stats()
    return computed


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


def _openviking_snapshot_path(case: Dict[str, Any], session: Optional[Dict[str, Any]] = None) -> Optional[Path]:
    relative = (session or {}).get("openviking_snapshot") if session is not None else case.get("final_openviking_snapshot")
    return _resolve_harness_path(case, relative)


def _openviking_state_json(snapshot: Optional[Path], name: str) -> Optional[Dict[str, Any]]:
    if snapshot is None:
        return None
    return _read_json_file(snapshot / "state" / name)


def _openviking_server_json(snapshot: Optional[Path], name: str) -> Optional[Dict[str, Any]]:
    if snapshot is None:
        return None
    return _read_json_file(snapshot / "server" / name)


def _json_text(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    except TypeError:
        return str(value or "")


def _openviking_result_items(payload: Optional[Dict[str, Any]]) -> List[Any]:
    if not payload:
        return []
    body = payload.get("body") if "body" in payload else payload
    candidates = []
    if isinstance(body, dict):
        candidates.extend([body.get("items"), body.get("results"), body.get("memories"), body.get("data")])
        nested = body.get("result")
        if isinstance(nested, dict):
            candidates.extend([nested.get("items"), nested.get("results"), nested.get("memories"), nested.get("data")])
    elif isinstance(body, list):
        candidates.append(body)
    for candidate in candidates:
        if isinstance(candidate, list):
            return candidate
        if isinstance(candidate, dict):
            for key in ("items", "results", "memories"):
                nested = candidate.get(key)
                if isinstance(nested, list):
                    return nested
    return []


def _openviking_capture_states(case: Dict[str, Any]) -> List[Dict[str, Any]]:
    states = []
    for session in case.get("sessions", []):
        capture = _openviking_state_json(_openviking_snapshot_path(case, session), "last-capture.json")
        if capture:
            states.append(capture)
    final_capture = _openviking_state_json(_openviking_snapshot_path(case), "last-capture.json")
    if final_capture:
        states.append(final_capture)
    return states


def _openviking_recall_states(case: Dict[str, Any]) -> List[Dict[str, Any]]:
    states = []
    for session in sorted(case.get("sessions", []), key=lambda item: item.get("session") or 0)[1:]:
        recall = _openviking_state_json(_openviking_snapshot_path(case, session), "last-recall.json")
        if recall:
            states.append(recall)
    return states


def _openviking_recall_count(recall: Dict[str, Any]) -> int:
    for key in ("recall_count", "result_count", "count", "items_count"):
        if key in recall:
            return _safe_int(recall.get(key))
    for key in ("items", "results", "memories"):
        value = recall.get(key)
        if isinstance(value, list):
            return len(value)
    return 1 if "<openviking-context" in _json_text(recall).lower() else 0


def _case_sessions(case: Dict[str, Any]) -> List[Dict[str, Any]]:
    return sorted(case.get("sessions", []), key=lambda item: item.get("session") or 0)


def _requires_cross_session_memory(case: Dict[str, Any]) -> bool:
    return len(_case_sessions(case)) >= 2


def openviking_capture_state(case: Dict[str, Any], variant: str) -> Metric:
    if variant not in OPENVIKING_VARIANTS:
        return _metric(None, "not_applicable", 0.0, ["OpenViking is disabled for this variant"])
    states = _openviking_capture_states(case)
    if not states:
        if not _requires_cross_session_memory(case):
            return _metric(None, "not_applicable", 0.0, ["fewer than two sessions; no cross-session capture required"])
        return _metric(0.0, "fail", 1.0, ["no OpenViking last-capture.json found for multi-session case"])
    captured = sum(_safe_int(state.get("turns_captured")) for state in states)
    failed = sum(_safe_int(state.get("turns_failed")) for state in states)
    queued = sum(_safe_int(state.get("turns_queued")) for state in states)
    evidence = [f"capture states: {len(states)}", f"turns_captured={captured}", f"turns_failed={failed}", f"turns_queued={queued}"]
    if captured > 0 and failed == 0 and queued == 0:
        return _metric(1.0, "pass", 0.95, evidence)
    if captured > 0 and failed == 0:
        return _metric(0.6, "partial", 0.8, evidence)
    return _metric(0.0, "fail", 0.9, evidence)


def openviking_recall_state(case: Dict[str, Any], variant: str) -> Metric:
    if variant not in OPENVIKING_VARIANTS:
        return _metric(None, "not_applicable", 0.0, ["OpenViking is disabled for this variant"])
    sessions = _case_sessions(case)
    if len(sessions) < 2:
        return _metric(None, "not_applicable", 0.0, ["fewer than two sessions"])
    states = _openviking_recall_states(case)
    recall_hits = sum(1 for state in states if _openviking_recall_count(state) > 0)
    evidence = [f"later recall states with hits: {recall_hits}/{len(sessions) - 1}"]
    if recall_hits == len(sessions) - 1:
        return _metric(1.0, "pass", 0.85, evidence)
    if recall_hits > 0:
        return _metric(0.5, "partial", 0.7, evidence)
    search_items = _openviking_result_items(_openviking_server_json(_openviking_snapshot_path(case), "search_probe.json"))
    if search_items:
        return _metric(0.35, "fail", 0.55, evidence + [f"final search probe returned {len(search_items)} item(s), but recall state did not show injection"])
    return _metric(0.0, "fail", 0.75, evidence)


def openviking_context_injection_state(case: Dict[str, Any], variant: str) -> Metric:
    if variant not in OPENVIKING_VARIANTS:
        return _metric(None, "not_applicable", 0.0, ["OpenViking is disabled for this variant"])
    if not _requires_cross_session_memory(case):
        return _metric(None, "not_applicable", 0.0, ["fewer than two sessions"])
    states = _openviking_recall_states(case)
    injection_hits = sum(1 for state in states if "<openviking-context" in _json_text(state).lower() or _openviking_recall_count(state) > 0)
    if not states:
        return _metric(0.0, "fail", 0.75, ["no later-session OpenViking recall state found"])
    evidence = [f"later recall states with injection evidence: {injection_hits}/{len(states)}"]
    if injection_hits == len(states):
        return _metric(1.0, "pass", 0.8, evidence)
    if injection_hits > 0:
        return _metric(0.5, "partial", 0.65, evidence)
    return _metric(0.0, "fail", 0.7, evidence)


def openviking_isolation_state(case: Dict[str, Any], variant: str) -> Metric:
    if variant not in OPENVIKING_VARIANTS:
        return _metric(None, "not_applicable", 0.0, ["OpenViking is disabled for this variant"])
    identity = case.get("openviking_identity") or (case.get("run_environment") or {}).get("openviking_identity") or {}
    case_id = str(case.get("case_id") or "")
    run_namespace = str(identity.get("run_namespace") or (case.get("run_environment") or {}).get("run_namespace") or "")
    user = str(identity.get("user") or "")
    peer_id = str(identity.get("peer_id") or "")
    evidence = [
        f"user={user or '(missing)'}",
        f"peer_id={peer_id or '(missing)'}",
        f"run_namespace={run_namespace or '(missing)'}",
    ]
    if not user or not peer_id:
        return _metric(0.0, "fail", 0.95, ["missing OpenViking user or peer_id"])
    score = 0.4
    if variant in user and variant in peer_id:
        score += 0.2
        evidence.append("variant appears in user and peer_id")
    if case_id and case_id in user and case_id in peer_id:
        score += 0.2
        evidence.append("case id appears in user and peer_id")
    if run_namespace and run_namespace in user and run_namespace in peer_id:
        score += 0.2
        evidence.append("run namespace appears in user and peer_id")
    bounded = round(min(1.0, score), 4)
    status = "pass" if bounded == 1.0 else ("partial" if bounded > 0 else "fail")
    return _metric(bounded, status, 0.8, evidence)


def score_openviking_backend_health(case: Dict[str, Any], variant: str) -> Optional[Dict[str, Metric]]:
    if variant not in OPENVIKING_VARIANTS:
        return None
    return {
        "capture_state": openviking_capture_state(case, variant),
        "recall_state": openviking_recall_state(case, variant),
        "context_injection_state": openviking_context_injection_state(case, variant),
        "isolation_state": openviking_isolation_state(case, variant),
    }


def _workspace_dir(case: Dict[str, Any]) -> Optional[Path]:
    harness = _harness_dir(case)
    if harness is None:
        return None
    workspace = harness.parent / "agent_root" / "workspace"
    return workspace if workspace.exists() and workspace.is_dir() else None


def _matches_path_glob(rel: str, pattern: str) -> bool:
    if fnmatch.fnmatch(rel, pattern) or PurePosixPath(rel).match(pattern):
        return True
    if "/**/" in pattern:
        return fnmatch.fnmatch(rel, pattern.replace("/**/", "/"))
    return False


def _iter_workspace_text_files(workspace: Optional[Path], path_glob: str) -> Iterable[Tuple[str, str]]:
    if workspace is None or not workspace.exists():
        return
    pattern = path_glob or "**/*"
    for path in sorted(p for p in workspace.rglob("*") if p.is_file()):
        rel = path.relative_to(workspace).as_posix()
        if not _matches_path_glob(rel, pattern):
            continue
        is_text, text = _is_text_file(path)
        if is_text:
            yield rel, text


def _workspace_delta_entries(case: Dict[str, Any]) -> List[Tuple[int, Path, Dict[str, Any]]]:
    """Return session-scoped workspace delta roots emitted by runner v2+ artifacts."""
    entries: List[Tuple[int, Path, Dict[str, Any]]] = []
    for session in case.get("sessions") or []:
        if not isinstance(session, dict) or not session.get("workspace_delta"):
            continue
        session_number = _safe_int(session.get("session"))
        snapshot = _resolve_harness_path(case, session.get("workspace_delta"))
        if snapshot is None or not snapshot.exists() or not snapshot.is_dir():
            continue
        files_root = snapshot / "files"
        manifest = _read_json_file(snapshot / "manifest.json") or {}
        entries.append((session_number, files_root, manifest))
    return sorted(entries, key=lambda item: item[0])


def _iter_delta_text_files(
    entries: Iterable[Tuple[int, Path, Dict[str, Any]]],
    path_glob: str,
) -> Iterable[Tuple[str, str]]:
    for session, root, _manifest in entries:
        for rel, text in _iter_workspace_text_files(root, path_glob):
            yield f"session_{session}:{rel}", text


def _regex_check_result_in_deltas(
    check_id: str,
    check: Dict[str, Any],
    entries: List[Tuple[int, Path, Dict[str, Any]]],
) -> Tuple[bool, str]:
    check_type = str(check.get("type") or "")
    pattern = str(check.get("pattern") or "")
    path_glob = str(check.get("path_glob") or "**/*")
    if check_type not in {"require_regex", "forbid_regex"}:
        return False, f"{check_id}: unsupported check type {check_type!r}"
    if not pattern:
        return False, f"{check_id}: empty regex pattern for {check_type}"
    try:
        regex = re.compile(pattern, re.MULTILINE | re.DOTALL)
    except re.error as exc:
        return False, f"{check_id}: invalid regex {pattern!r}: {exc}"

    matched_files = []
    scanned_files = 0
    for rel, text in _iter_delta_text_files(entries, path_glob):
        scanned_files += 1
        if regex.search(text):
            matched_files.append(rel)
    scope = "later-session changed files"
    if check_type == "require_regex":
        if matched_files:
            return True, f"{check_id}: require_regex matched {len(matched_files)} {scope}"
        return False, f"{check_id}: require_regex matched 0/{scanned_files} {scope}"
    if matched_files:
        examples = ", ".join(matched_files[:3])
        suffix = "..." if len(matched_files) > 3 else ""
        return False, f"{check_id}: forbid_regex matched forbidden text in {examples}{suffix}"
    return True, f"{check_id}: forbid_regex found no matches across {scanned_files} {scope}"


def _file_exists_in_deltas(
    check_id: str,
    check: Dict[str, Any],
    entries: List[Tuple[int, Path, Dict[str, Any]]],
) -> Tuple[bool, str]:
    path_glob = str(check.get("path_glob") or check.get("path") or "")
    matched = []
    for session, _root, manifest in entries:
        for rel in (manifest.get("added") or []) + (manifest.get("modified") or []):
            if path_glob and _matches_path_glob(str(rel), path_glob):
                matched.append(f"session_{session}:{rel}")
    if matched:
        return True, f"{check_id}: file_exists matched later-session change {matched[0]}"
    return False, f"{check_id}: file_exists found no later-session change for {path_glob}"


def _delta_entry_has_matching_change(
    entry: Tuple[int, Path, Dict[str, Any]],
    path_glob: str,
) -> bool:
    """Return whether one session changed a path covered by a contract check."""
    _session, _root, manifest = entry
    pattern = path_glob or "**/*"
    changed = (manifest.get("added") or []) + (manifest.get("modified") or []) + (manifest.get("deleted") or [])
    return any(_matches_path_glob(str(relative), pattern) for relative in changed)


def _regex_check_result(check_id: str, check: Dict[str, Any], workspace: Optional[Path]) -> Tuple[bool, str]:
    check_type = str(check.get("type") or "")
    pattern = str(check.get("pattern") or "")
    path_glob = str(check.get("path_glob") or "**/*")
    if check_type not in {"require_regex", "forbid_regex"}:
        return False, f"{check_id}: unsupported check type {check_type!r}"
    if not pattern:
        return False, f"{check_id}: empty regex pattern for {check_type}"
    try:
        regex = re.compile(pattern, re.MULTILINE | re.DOTALL)
    except re.error as exc:
        return False, f"{check_id}: invalid regex {pattern!r}: {exc}"

    matched_files = []
    scanned_files = 0
    for rel, text in _iter_workspace_text_files(workspace, path_glob):
        scanned_files += 1
        if regex.search(text):
            matched_files.append(rel)

    if check_type == "require_regex":
        if matched_files:
            return True, f"{check_id}: require_regex matched {len(matched_files)} file(s) for {path_glob}"
        return False, f"{check_id}: require_regex matched 0/{scanned_files} file(s) for {path_glob}"

    if matched_files:
        examples = ", ".join(matched_files[:3])
        suffix = "..." if len(matched_files) > 3 else ""
        return False, f"{check_id}: forbid_regex matched forbidden text in {examples}{suffix}"
    return True, f"{check_id}: forbid_regex found no matches across {scanned_files} file(s) for {path_glob}"


def _score_regex_checks(checks: Any, workspace: Optional[Path], label: str) -> Metric:
    if not checks:
        return _metric(None, "not_applicable", 0.0, [f"no {label} configured"])
    if not isinstance(checks, list):
        return _metric(0.0, "fail", 0.9, [f"{label} must be a list"])
    if workspace is None:
        return _metric(0.0, "fail", 1.0, ["agent workspace not found for checks"])

    total_checks = 0
    passed_checks = 0
    evidence = []
    for index, check in enumerate(checks, start=1):
        if not isinstance(check, dict):
            total_checks += 1
            evidence.append(f"{label}_{index}: invalid check shape")
            continue
        check_id = str(check.get("id") or f"{label}_{index}")
        metadata = []
        for meta_key, meta_label in (("source", "source"), ("strength", "strength"), ("signal_kind", "kind")):
            if check.get(meta_key):
                metadata.append(f"{meta_label}={check.get(meta_key)}")
        meta_prefix = f"{check_id} [{' '.join(metadata)}]" if metadata else check_id
        if check.get("type") in {"require_regex", "forbid_regex"}:
            total_checks += 1
            passed, message = _regex_check_result(meta_prefix, check, workspace)
        elif check.get("type") == "file_exists":
            total_checks += 1
            path_glob = str(check.get("path_glob") or check.get("path") or "")
            matched = any(True for _rel, _text in _iter_workspace_text_files(workspace, path_glob)) if path_glob else False
            passed = matched
            message = f"{meta_prefix}: file_exists matched {path_glob}" if matched else f"{meta_prefix}: file_exists found no match for {path_glob}"
        elif "passed" in check:
            total_checks += 1
            passed = bool(check.get("passed"))
            message = f"{meta_prefix}: precomputed passed={passed}"
        else:
            total_checks += 1
            passed = False
            message = f"{meta_prefix}: unsupported check shape"
        if check.get("rationale"):
            message = f"{message}; rationale={check.get('rationale')}"
        if passed:
            passed_checks += 1
        evidence.append(message)

    if total_checks == 0:
        return _metric(None, "not_applicable", 0.0, [f"{label} contains no executable checks"] + evidence)
    score = passed_checks / total_checks
    evidence.insert(0, f"{label} checks passed: {passed_checks}/{total_checks}")
    return _metric(round(score, 4), _status_from_score(score), 0.9, evidence)


def _memory_fact_check_result(fact_id: str, fact: Dict[str, Any], memory_text: str) -> Tuple[Optional[bool], str]:
    """Return whether a prepared memory fact matches backend text, or None if it has no checks."""
    required_keywords = [str(item).lower() for item in fact.get("required_keywords") or []]
    required_regex = [str(item) for item in fact.get("required_regex") or []]
    forbidden_keywords = [str(item).lower() for item in fact.get("forbidden_keywords") or []]
    if not required_keywords and not required_regex and not forbidden_keywords:
        return None, f"{fact_id}: no executable memory fact checks"

    missing_keywords = [keyword for keyword in required_keywords if keyword not in memory_text]
    missing_regex = [
        pattern
        for pattern in required_regex
        if not re.search(pattern, memory_text, re.MULTILINE | re.DOTALL | re.IGNORECASE)
    ]
    forbidden_hits = [keyword for keyword in forbidden_keywords if keyword in memory_text]
    ok = not missing_keywords and not missing_regex and not forbidden_hits
    details = []
    if missing_keywords:
        details.append(f"missing_keywords={missing_keywords[:5]}")
    if missing_regex:
        details.append(f"missing_regex={missing_regex[:3]}")
    if forbidden_hits:
        details.append(f"forbidden_hits={forbidden_hits[:5]}")
    suffix = f" ({'; '.join(details)})" if details else ""
    return ok, f"{fact_id}: memory_fact matched={ok}{suffix}"


def _workspace_contract_check_result(check_id: str, check: Dict[str, Any], workspace: Optional[Path]) -> Tuple[bool, str]:
    """Return whether one workspace contract check passes, counting config/workspace issues as failures."""
    if workspace is None:
        return False, f"{check_id}: agent workspace not found for checks"
    if check.get("type") in {"require_regex", "forbid_regex"}:
        return _regex_check_result(check_id, check, workspace)
    if check.get("type") == "file_exists":
        path_glob = str(check.get("path_glob") or check.get("path") or "")
        matched = any(True for _rel, _text in _iter_workspace_text_files(workspace, path_glob)) if path_glob else False
        if matched:
            return True, f"{check_id}: file_exists matched {path_glob}"
        return False, f"{check_id}: file_exists found no match for {path_glob}"
    if "passed" in check:
        passed = bool(check.get("passed"))
        return passed, f"{check_id}: precomputed passed={passed}"
    return False, f"{check_id}: unsupported check shape"


def score_contract_compliance(case: Dict[str, Any], variant: str, prepared_dir: Optional[Path]) -> Metric:
    """Score contracts only from files added or modified after the introduction session."""
    scenario_id = str(case.get("scenario_id") or case.get("case_id") or "")
    reference = _raw_case_reference_for_case(case, prepared_dir)
    contracts = (reference or {}).get("memory_contracts") or []
    if not contracts:
        return _metric(None, "not_applicable", 0.0, ["no memory_contracts in scoring_reference.json"])
    if not isinstance(contracts, list):
        return _metric(0.0, "fail", 0.9, ["memory_contracts must be a list"])

    home_isolation = str((case.get("run_environment") or {}).get("home_isolation") or "")
    if home_isolation != "per_session":
        return _metric(
            None,
            "not_applicable",
            0.0,
            [
                "session HOME/XDG isolation is not recorded as per_session; CLI history may be an alternate continuity channel",
                f"home_isolation={home_isolation or '(missing)'}",
            ],
        )

    delta_entries = _workspace_delta_entries(case)
    if not delta_entries:
        return _metric(
            None,
            "not_applicable",
            0.0,
            [
                "no per-session workspace delta evidence; legacy final-workspace artifacts cannot prove cross-session compliance",
                "rerun with a runner that records sessions[].workspace_delta",
            ],
        )
    total_checks = 0
    passed_checks = 0
    workspace_check_count = 0
    contracts_without_checks = 0
    contracts_without_positive_checks = 0
    contaminated_checks = 0
    unavailable_checks = 0
    contract_scores: List[float] = []
    evidence = []

    for index, contract in enumerate(contracts, start=1):
        if not isinstance(contract, dict):
            evidence.append(f"contract_{index}: invalid contract shape")
            continue
        contract_id = str(contract.get("id") or f"contract_{index}")
        introduced_session = _safe_int(contract.get("introduced_in_session")) or 1
        effective_session = _safe_int(contract.get("workspace_effective_from_session")) or introduced_session + 1
        introduction_entries = [
            entry for entry in delta_entries if introduced_session <= entry[0] < effective_session
        ]
        later_entries = [entry for entry in delta_entries if entry[0] >= effective_session]
        contract_checks = contract.get("checks") or []
        if not isinstance(contract_checks, list):
            evidence.append(f"{contract_id}: checks must be a list")
            continue
        if not contract_checks:
            contracts_without_checks += 1
            evidence.append(f"{contract_id}: no later-session workspace/output checks configured")
            continue

        configured_positive = any(
            isinstance(check, dict) and str(check.get("type") or "") in {"require_regex", "file_exists"}
            for check in contract_checks
        )
        if not configured_positive:
            contracts_without_positive_checks += 1
            evidence.append(f"{contract_id}: excluded because it has only negative or non-positive checks")
            continue

        contract_check_scores: List[float] = []
        contract_final_results: List[bool] = []
        contract_scoreable_checks = 0
        contract_fully_passed_checks = 0
        scoreable_positive = 0
        for check_index, check in enumerate(contract_checks, start=1):
            if not isinstance(check, dict):
                contract_check_scores.append(0.0)
                contract_scoreable_checks += 1
                evidence.append(f"{contract_id}:workspace_{check_index}: invalid check shape")
                continue
            workspace_check_count += 1
            check_id = f"{contract_id}:{check.get('id') or f'workspace_{check_index}'}"
            check_type = str(check.get("type") or "")
            is_positive = check_type in {"require_regex", "file_exists"}
            if is_positive and introduction_entries:
                if check_type == "require_regex":
                    already_satisfied, _ = _regex_check_result_in_deltas(check_id, check, introduction_entries)
                else:
                    already_satisfied, _ = _file_exists_in_deltas(check_id, check, introduction_entries)
                if already_satisfied:
                    contaminated_checks += 1
                    evidence.append(
                        f"{check_id}: excluded because the introduction-session workspace already satisfied it"
                    )
                    continue
            if check_type in {"require_regex", "forbid_regex", "file_exists"}:
                path_glob = str(check.get("path_glob") or check.get("path") or "**/*")
                applicable_entries = [
                    entry for entry in later_entries if _delta_entry_has_matching_change(entry, path_glob)
                ]
                if not applicable_entries:
                    unavailable_checks += 1
                    evidence.append(
                        f"{check_id}: no applicable path changes at or after session {effective_session}"
                    )
                    continue

                session_results: List[bool] = []
                for entry in applicable_entries:
                    session_number = entry[0]
                    if check_type in {"require_regex", "forbid_regex"}:
                        passed, message = _regex_check_result_in_deltas(check_id, check, [entry])
                    else:
                        passed, message = _file_exists_in_deltas(check_id, check, [entry])
                    session_results.append(passed)
                    evidence.append(f"{check_id}: session_{session_number} {'pass' if passed else 'fail'}; {message}")

                check_score = sum(1 for passed in session_results if passed) / len(session_results)
                contract_check_scores.append(check_score)
                contract_scoreable_checks += 1
                if check_score == 1.0:
                    contract_fully_passed_checks += 1
                if is_positive:
                    scoreable_positive += 1
                final_passed, final_message = _workspace_contract_check_result(
                    check_id,
                    check,
                    _workspace_dir(case),
                )
                contract_final_results.append(final_passed)
                evidence.append(
                    f"{check_id}: applicable-session score={round(check_score, 4)} "
                    f"({sum(1 for passed in session_results if passed)}/{len(session_results)}); "
                    f"final_state={'pass' if final_passed else 'fail'}; {final_message}"
                )
                continue

            if "passed" in check:
                passed = bool(check.get("passed"))
                contract_check_scores.append(1.0 if passed else 0.0)
                contract_final_results.append(passed)
                contract_scoreable_checks += 1
                if passed:
                    contract_fully_passed_checks += 1
                evidence.append(f"{check_id}: precomputed passed={passed}")
                continue

            contract_check_scores.append(0.0)
            contract_scoreable_checks += 1
            evidence.append(f"{check_id}: unsupported check shape")

        if not scoreable_positive:
            contracts_without_positive_checks += 1
            evidence.append(f"{contract_id}: no uncontaminated positive later-session check is scoreable")
            continue
        total_checks += contract_scoreable_checks
        passed_checks += contract_fully_passed_checks
        contract_score = sum(contract_check_scores) / len(contract_check_scores)
        contract_scores.append(contract_score)
        final_score = (
            sum(1 for passed in contract_final_results if passed) / len(contract_final_results)
            if contract_final_results
            else None
        )
        evidence.append(
            f"{contract_id}: contract score={round(contract_score, 4)}; "
            f"final_state_score={round(final_score, 4) if final_score is not None else 'N/A'}"
        )

    evidence.insert(
        0,
        "contract compliance evidence: "
        f"workspace_checks={workspace_check_count}, contaminated_checks={contaminated_checks}, "
        f"unavailable_checks={unavailable_checks}, no_check_contracts={contracts_without_checks}, "
        f"no_positive_contracts={contracts_without_positive_checks}",
    )
    if not contract_scores:
        return _metric(None, "not_applicable", 0.0, evidence + ["no uncontaminated later-session checks are scoreable"])
    score = sum(contract_scores) / len(contract_scores)
    evidence.insert(0, f"contract compliance fully-passed checks: {passed_checks}/{total_checks}")
    evidence.insert(1, f"contract compliance uses equal contract weights: {len(contract_scores)} contract(s)")
    return _metric(round(score, 4), _status_from_score(score), 0.9, evidence)


def _test_result_is_runnable_valid(test_result: Dict[str, Any]) -> bool:
    """Return whether a runtime test result should enter the pass-rate denominator."""
    if not isinstance(test_result, dict) or not test_result:
        return False
    status = str(test_result.get("status") or "")
    environment_status = str(test_result.get("environment_status") or "ready")
    integrity_status = str(test_result.get("integrity_status") or "not_checked")
    if integrity_status == "failed" or status in {"invalid", "skipped", "timeout"}:
        return False
    if environment_status not in {"ready", "", "not_checked"}:
        return False
    return status in {"passed", "failed"} or test_result.get("exit_code") is not None


def _test_result_evidence(test_result: Dict[str, Any]) -> List[str]:
    status = str(test_result.get("status") or "")
    command_text = " ".join(str(item) for item in (test_result.get("command") or []))
    source = test_result.get("source") or "unknown"
    environment_status = str(test_result.get("environment_status") or "ready")
    integrity_status = str(test_result.get("integrity_status") or "not_checked")
    failure_classification = test_result.get("failure_classification")
    evidence = [
        f"post-run test status={status}",
        f"source={source}",
        f"environment_status={environment_status}",
        f"integrity_status={integrity_status}",
    ]
    if command_text:
        evidence.append(f"command={command_text}")
    if test_result.get("executor"):
        evidence.append(f"executor={test_result.get('executor')}")
    if failure_classification:
        evidence.append(f"failure_classification={failure_classification}")
    if test_result.get("missing_dependency"):
        evidence.append(f"missing_dependency={test_result.get('missing_dependency')}")
    if test_result.get("integrity_reason"):
        evidence.append(f"integrity_reason={test_result.get('integrity_reason')}")
    if test_result.get("reason"):
        evidence.append(f"reason={test_result.get('reason')}")
    return evidence


def score_test_runnable_rate(case: Dict[str, Any], variant: str, prepared_dir: Optional[Path]) -> Metric:
    test_result = case.get("test_result") or {}
    if not isinstance(test_result, dict) or not test_result:
        return _metric(0.0, "fail", 0.95, ["no runtime test_result; test did not run"])
    evidence = _test_result_evidence(test_result)
    if _test_result_is_runnable_valid(test_result):
        return _metric(1.0, "pass", 0.95, evidence + ["test result is runnable-valid and enters pass-rate denominator"])
    return _metric(0.0, "fail", 0.95, evidence + ["test result is not runnable-valid and is excluded from pass-rate denominator"])


def score_test_pass_rate(case: Dict[str, Any], variant: str, prepared_dir: Optional[Path]) -> Metric:
    scenario_id = str(case.get("scenario_id") or case.get("case_id") or "")
    test_result = case.get("test_result") or {}
    if isinstance(test_result, dict) and test_result:
        status = str(test_result.get("status") or "")
        exit_code = test_result.get("exit_code")
        command_text = " ".join(str(item) for item in (test_result.get("command") or []))
        source = test_result.get("source") or "unknown"
        environment_status = str(test_result.get("environment_status") or "ready")
        integrity_status = str(test_result.get("integrity_status") or "not_checked")
        failure_classification = test_result.get("failure_classification")
        evidence = [
            f"post-run test status={status}",
            f"source={source}",
            f"environment_status={environment_status}",
            f"integrity_status={integrity_status}",
        ]
        if command_text:
            evidence.append(f"command={command_text}")
        if test_result.get("executor"):
            evidence.append(f"executor={test_result.get('executor')}")
        if failure_classification:
            evidence.append(f"failure_classification={failure_classification}")
        if test_result.get("missing_dependency"):
            evidence.append(f"missing_dependency={test_result.get('missing_dependency')}")
        if test_result.get("integrity_reason"):
            evidence.append(f"integrity_reason={test_result.get('integrity_reason')}")
        if test_result.get("reason"):
            evidence.append(f"reason={test_result.get('reason')}")
        if integrity_status == "failed" or status == "invalid":
            return _metric(None, "not_applicable", 0.0, evidence + ["test result excluded because test integrity failed"])
        if environment_status not in {"ready", "", "not_checked"}:
            return _metric(None, "not_applicable", 0.0, evidence + ["test result excluded because test environment was not ready"])
        if status == "passed" or exit_code == 0:
            return _metric(1.0, "pass", 0.95, evidence + [f"test exit_code={exit_code}"])
        if status == "failed" or (exit_code not in (None, 0) and status not in {"skipped", ""}):
            return _metric(0.0, "fail", 0.95, evidence + [f"test exit_code={exit_code}"])
        return _metric(None, "not_applicable", 0.0, evidence)

    reference = _raw_case_reference_for_case(case, prepared_dir) or {}
    results = reference.get("test_results") or reference.get("tests")
    if isinstance(results, dict):
        total = _safe_int(results.get("total_tests") or results.get("total"))
        passed = _safe_int(results.get("passed_tests") or results.get("passed"))
        if total:
            score = passed / total
            return _metric(round(score, 4), _status_from_score(score), 0.95, [f"tests passed: {passed}/{total}"])
        if "exit_code" in results:
            passed_flag = _safe_int(results.get("exit_code")) == 0
            return _metric(1.0 if passed_flag else 0.0, "pass" if passed_flag else "fail", 0.9, [f"test exit_code={results.get('exit_code')}"])
    checks = reference.get("test_checks")
    if checks:
        return _score_regex_checks(checks, _workspace_dir(case), "test")
    test_plan = reference.get("test_plan") or {}
    if isinstance(test_plan, dict) and test_plan.get("reason"):
        return _metric(None, "not_applicable", 0.0, [f"no runtime test result; test_plan {test_plan.get('status')}: {test_plan.get('reason')}"])
    return _metric(None, "not_applicable", 0.0, ["no project test results, runtime test_result, or test_checks configured"])


def score_requirement_rule_coverage(case: Dict[str, Any], variant: str, prepared_dir: Optional[Path]) -> Metric:
    scenario_id = str(case.get("scenario_id") or case.get("case_id") or "")
    reference = _raw_case_reference_for_case(case, prepared_dir) or {}
    checks = reference.get("requirement_checks")
    if not checks:
        plan = reference.get("requirement_check_plan") or {}
        if isinstance(plan, dict):
            reason = plan.get("reason") or plan.get("status") or "not_configured"
            source = plan.get("source") or "unknown"
            evidence = [f"requirement checks not configured: {reason}", f"source={source}"]
            rejected = plan.get("rejected_terms") or []
            if rejected:
                evidence.append(f"rejected_terms={len(rejected)}")
            return _metric(None, "not_applicable", 0.0, evidence)
    if not isinstance(checks, list):
        return _metric(0.0, "fail", 0.9, ["requirement checks must be a list"])
    if not any(
        isinstance(check, dict) and str(check.get("type") or "") in {"require_regex", "file_exists"}
        for check in checks
    ):
        return _metric(
            None,
            "not_applicable",
            0.0,
            ["requirement checks contain no positive evaluator-owned check; negative-only checks are not scoreable"],
        )
    delta_entries = _workspace_delta_entries(case)
    if not delta_entries:
        return _metric(
            None,
            "not_applicable",
            0.0,
            ["no per-session workspace delta evidence; initial project content cannot be excluded"],
        )

    passed_checks = 0
    total_checks = 0
    evidence = []
    for index, check in enumerate(checks, start=1):
        if not isinstance(check, dict):
            total_checks += 1
            evidence.append(f"requirement_{index}: invalid check shape")
            continue
        check_id = str(check.get("id") or f"requirement_{index}")
        metadata = " ".join(
            f"{label}={check.get(key)}"
            for key, label in (("source", "source"), ("strength", "strength"), ("signal_kind", "kind"))
            if check.get(key)
        )
        display_id = f"{check_id} [{metadata}]" if metadata else check_id
        check_type = str(check.get("type") or "")
        total_checks += 1
        if check_type in {"require_regex", "forbid_regex"}:
            passed, message = _regex_check_result_in_deltas(display_id, check, delta_entries)
        elif check_type == "file_exists":
            passed, message = _file_exists_in_deltas(display_id, check, delta_entries)
        else:
            passed = False
            message = f"{display_id}: unsupported requirement check shape"
        if check.get("rationale"):
            message = f"{message}; rationale={check.get('rationale')}"
        if passed:
            passed_checks += 1
        evidence.append(message)
    if total_checks == 0:
        return _metric(None, "not_applicable", 0.0, ["requirement contains no executable checks"])
    score = passed_checks / total_checks
    evidence.insert(0, f"requirement checks passed in session deltas: {passed_checks}/{total_checks}")
    return _metric(round(score, 4), _status_from_score(score), 0.9, evidence)


def _memory_backend_text(case: Dict[str, Any], variant: str, max_chars: int = 200_000) -> Tuple[str, List[str]]:
    evidence = []
    pieces = []
    if variant in {"memory_on", "native_memory_on"}:
        snapshot = _resolve_harness_path(case, case.get("final_memory_snapshot"))
        summary = _memory_snapshot_summary(snapshot)
        evidence.append(f"native memory files: {summary['file_count']}")
        evidence.append(f"native memory snapshot: {snapshot if snapshot is not None else '(missing)'}")
        if snapshot is not None and snapshot.exists() and snapshot.is_dir():
            for path in sorted(p for p in snapshot.rglob("*") if p.is_file()):
                is_text, text = _is_text_file(path)
                if is_text:
                    pieces.append(text)
                    evidence.append(f"native memory text file: {path.relative_to(snapshot).as_posix()}")
    elif variant == "openviking_on":
        final_snapshot = _openviking_snapshot_path(case)
        for name in ("search_probe.json", "session_context.json"):
            payload = _openviking_server_json(final_snapshot, name)
            if payload:
                pieces.append(_json_text(payload))
                evidence.append(f"OpenViking {name} present")
        for state in _openviking_capture_states(case) + _openviking_recall_states(case):
            pieces.append(_json_text(state))
    return _truncate_text("\n".join(pieces), max_chars).lower(), evidence


def score_memory_content_quality(case: Dict[str, Any], variant: str, prepared_dir: Optional[Path]) -> Metric:
    if variant not in MEMORY_METRIC_VARIANTS:
        return _metric(None, "not_applicable", 0.0, ["memory is disabled for this variant"])
    scenario_id = str(case.get("scenario_id") or case.get("case_id") or "")
    reference = _raw_case_reference_for_case(case, prepared_dir) or {}
    facts = reference.get("expected_memory_facts") or []
    if not facts:
        return _metric(None, "not_applicable", 0.0, ["no expected_memory_facts configured"])
    if not isinstance(facts, list):
        return _metric(0.0, "fail", 0.9, ["expected_memory_facts must be a list"])
    memory_text, evidence = _memory_backend_text(case, variant)
    if not memory_text.strip():
        return _metric(0.0, "fail", 0.9, evidence + ["memory backend text is empty or unavailable"])

    total = 0
    score_sum = 0.0
    for index, fact in enumerate(facts, start=1):
        if not isinstance(fact, dict):
            total += 1
            evidence.append(f"fact_{index}: invalid fact shape")
            continue
        fact_id = str(fact.get("id") or f"fact_{index}")
        required_keywords = [str(item).lower() for item in fact.get("required_keywords") or []]
        required_regex = [str(item) for item in fact.get("required_regex") or []]
        forbidden_keywords = [str(item).lower() for item in fact.get("forbidden_keywords") or []]
        if not required_keywords and not required_regex and not forbidden_keywords:
            evidence.append(f"{fact_id}: no executable fact checks")
            continue
        total += 1
        keyword_hits = [keyword for keyword in required_keywords if keyword in memory_text]
        keyword_score = len(keyword_hits) / len(required_keywords) if required_keywords else 1.0
        regex_ok = all(re.search(pattern, memory_text, re.MULTILINE | re.DOTALL | re.IGNORECASE) for pattern in required_regex)
        forbidden_hits = [keyword for keyword in forbidden_keywords if keyword in memory_text]
        fact_score = keyword_score if regex_ok and not forbidden_hits else 0.0
        score_sum += fact_score
        details = [f"keyword_hits={len(keyword_hits)}/{len(required_keywords)}"] if required_keywords else []
        if required_regex:
            details.append(f"regex_ok={regex_ok}")
        if forbidden_hits:
            details.append(f"forbidden_hits={forbidden_hits[:5]}")
        evidence.append(f"{fact_id}: score={round(fact_score, 4)}" + (f" ({'; '.join(details)})" if details else ""))
    if total == 0:
        return _metric(None, "not_applicable", 0.0, ["expected_memory_facts contain no executable checks"] + evidence)
    score = score_sum / total
    evidence.insert(0, f"expected memory fact score sum: {round(score_sum, 4)}/{total}")
    return _metric(round(score, 4), _status_from_score(score), 0.85, evidence)


def _tool_counts_from_stream(stream_log: Optional[Path]) -> Counter:
    counts: Counter = Counter()
    if stream_log is None or not stream_log.exists() or not stream_log.is_file():
        return counts
    try:
        with stream_log.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                containers = []
                message = event.get("message")
                if isinstance(message, dict):
                    containers.append(message.get("content"))
                containers.append(event.get("content"))
                for content in containers:
                    if not isinstance(content, list):
                        continue
                    for item in content:
                        if not isinstance(item, dict) or item.get("type") != "tool_use":
                            continue
                        name = str(item.get("name") or "unknown")
                        counts["tool_call_count"] += 1
                        lower = name.lower()
                        if name in {"Read", "Grep", "Glob", "LS", "List"} or "search" in lower:
                            counts["search_or_read_tool_call_count"] += 1
                        if name == "Bash":
                            counts["bash_tool_call_count"] += 1
                        if name in {"Edit", "Write", "MultiEdit", "NotebookEdit"}:
                            counts["edit_tool_call_count"] += 1
                        if "openviking" in lower or "memory" in lower:
                            counts["memory_tool_call_count"] += 1
    except OSError:
        return counts
    return counts


def _sum_tool_totals(cases: Iterable[Dict[str, Any]]) -> Dict[str, int]:
    totals: Counter = Counter()
    for case in cases:
        for session in case.get("sessions", []):
            totals.update(_tool_counts_from_stream(_resolve_harness_path(case, session.get("stream_json_log"))))
    return {key: int(totals.get(key, 0)) for key in TOOL_COMPARISON_KEYS}


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
    if not llm_judge or llm_judge is False or (isinstance(llm_judge, dict) and llm_judge.get("enabled") is False):
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
        "position_swap": llm_judge.get("position_swap") is not False,
    }


def _redact_variant_labels(text: str) -> str:
    """Remove variant/backend labels from judge-visible text."""
    redacted = text
    for label in (
        "native_memory_on",
        "openviking_on",
        "memory_off",
        "memory_on",
        "openviking",
        "memory-off",
        "memory-on",
    ):
        redacted = redacted.replace(label, "[hidden_variant]")
    return redacted


def _balanced_diff_excerpt(path: Optional[Path], max_chars: int) -> str:
    text = _read_text_excerpt(path, max(max_chars * 8, max_chars))
    if not text or len(text) <= max_chars:
        return text
    sections = [section for section in re.split(r"(?=^diff --git )", text, flags=re.MULTILINE) if section.strip()]
    if len(sections) <= 1:
        return _truncate_text(text, max_chars)
    per_section = max(160, max_chars // min(len(sections), 12))
    return _truncate_text("\n".join(_truncate_text(section, per_section) for section in sections[:12]), max_chars)


def _changed_file_excerpts(case: Dict[str, Any], max_chars: int) -> List[Dict[str, str]]:
    workspace = _workspace_dir(case)
    if workspace is None or max_chars <= 0:
        return []
    changed = {
        str(path)
        for session in case.get("sessions", [])
        for path in (session.get("files_changed") or [])
        if path
    }

    def priority(path: str) -> Tuple[int, str]:
        lower = path.lower()
        if "test" in lower or "spec" in lower:
            return (0, path)
        if lower.endswith((".c", ".cc", ".cpp", ".h", ".py", ".js", ".ts", ".tsx", ".go", ".rs", ".java")):
            return (1, path)
        if Path(lower).name in {"makefile", "dockerfile"} or lower.endswith((".json", ".yaml", ".yml", ".toml")):
            return (2, path)
        return (3, path)

    selected = sorted(changed, key=priority)[:10]
    per_file = max(240, max_chars // max(1, len(selected)))
    excerpts: List[Dict[str, str]] = []
    for relative in selected:
        path = workspace / relative
        try:
            resolved = path.resolve()
            resolved.relative_to(workspace.resolve())
        except (OSError, ValueError):
            continue
        if not resolved.is_file():
            continue
        is_text, content = _is_text_file(resolved)
        if is_text:
            excerpts.append({"path": relative, "content": _truncate_text(content, per_file)})
    return excerpts


def _test_evidence_payload(case: Dict[str, Any], max_chars: int) -> Dict[str, Any]:
    test_result = case.get("test_result") or {}
    if not isinstance(test_result, dict) or not test_result:
        return {"present": False}
    excerpt_budget = max(200, max_chars // 2)
    return {
        "present": True,
        "status": test_result.get("status"),
        "exit_code": test_result.get("exit_code"),
        "environment_status": test_result.get("environment_status"),
        "integrity_status": test_result.get("integrity_status"),
        "failure_classification": test_result.get("failure_classification"),
        "command": test_result.get("command"),
        "reason": test_result.get("reason") or test_result.get("integrity_reason"),
        "stdout_excerpt": _read_text_excerpt(_resolve_harness_path(case, test_result.get("stdout")), excerpt_budget),
        "stderr_excerpt": _read_text_excerpt(_resolve_harness_path(case, test_result.get("stderr")), excerpt_budget),
    }


def _submission_payload(case: Dict[str, Any], variant: str, max_chars: int) -> Dict[str, Any]:
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
    diff_budget = max(500, int(max_chars * 0.4))
    files_budget = max(500, int(max_chars * 0.35))
    tests_budget = max(400, max_chars - diff_budget - files_budget)
    return {
        "sessions": sessions,
        "case_errors": case.get("errors") or [],
        "final_diff_excerpt": _balanced_diff_excerpt(_resolve_harness_path(case, case.get("final_diff")), diff_budget),
        "changed_file_excerpts": _changed_file_excerpts(case, files_budget),
        "post_run_test": _test_evidence_payload(case, tests_budget),
    }


def _budgeted_reference(reference: Dict[str, Any], max_chars: int) -> Any:
    encoded = json.dumps(reference, ensure_ascii=False, sort_keys=True)
    if len(encoded) <= max_chars:
        return reference
    return {"truncated_json": _truncate_text(encoded, max_chars)}


def _build_pairwise_judge_prompt(
    baseline_case: Dict[str, Any],
    baseline_variant: str,
    candidate_case: Dict[str, Any],
    candidate_variant: str,
    prepared_dir: Optional[Path],
    max_chars: int,
) -> Tuple[Optional[str], Optional[Dict[str, Any]], Optional[str]]:
    scenario_id = str(baseline_case.get("scenario_id") or baseline_case.get("case_id") or "")
    reference = _raw_case_reference_for_case(baseline_case, prepared_dir)
    if reference is None:
        return None, None, "missing scoring_reference.json"
    per_submission_chars = max(1200, max_chars // 4)
    reference_chars = max(1000, max_chars // 4)
    payload = {
        "scenario_id": scenario_id,
        "case_id": baseline_case.get("case_id"),
        "submission_A": _submission_payload(baseline_case, baseline_variant, per_submission_chars),
        "submission_B": _submission_payload(candidate_case, candidate_variant, per_submission_chars),
        "confidential_scoring_reference": _budgeted_reference(reference, reference_chars),
    }
    prompt = f"""You are an evaluator for a LoCoBench multi-session coding benchmark.

You will compare two anonymous submissions for the same case. You are blinded to the backend or variant that produced each submission. Judge only implementation quality, session outcomes, balanced diff/file excerpts, post-run test evidence, and the confidential scoring reference.

Do not quote or reveal confidential reference text. Do not infer or mention hidden variant names.

Return ONLY a JSON object with this exact shape:
{{
  "verdict": "A_better",
  "rationale": "one concise non-confidential explanation",
  "evidence": ["short non-confidential evidence item"]
}}

Allowed verdict values: A_better, B_better, tie, both_bad, judge_uncertain.
Use both_bad when neither submission satisfies the task. Use judge_uncertain only when the available evidence is insufficient.

Evaluation payload:
{json.dumps(payload, ensure_ascii=False, indent=2)}
"""
    redacted = _redact_variant_labels(prompt)
    if len(redacted) > max_chars:
        return None, reference, "judge payload exceeds max_chars after structured budgeting"
    return redacted, reference, None


def _extract_json_object(text: str) -> Dict[str, Any]:
    stripped = text.strip()
    if not stripped:
        raise ValueError("empty judge output")
    try:
        parsed = json.loads(stripped)
        if isinstance(parsed, dict):
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


def _normalise_pairwise_payload(payload: Dict[str, Any], reference: Optional[Dict[str, Any]], model: str) -> Dict[str, Any]:
    verdict = str(payload.get("verdict") or "judge_uncertain")
    if verdict not in PAIRWISE_VERDICTS:
        verdict = "judge_uncertain"
    evidence_value = payload.get("evidence") or []
    if not isinstance(evidence_value, list):
        evidence_value = [evidence_value]
    return {
        "enabled": True,
        "status": "pass" if verdict in PAIRWISE_VERDICTS - {"judge_uncertain"} else "judge_uncertain",
        "model": payload.get("model") or model,
        "verdict": verdict,
        "rationale": _safe_judge_string(payload.get("rationale"), reference, 1000),
        "evidence": [_safe_judge_string(item, reference, 300) for item in evidence_value[:5]],
        "error": None,
    }


def _run_pairwise_judge_command(prompt: str, reference: Optional[Dict[str, Any]], config: Dict[str, Any]) -> Dict[str, Any]:
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
            "verdict": "judge_uncertain",
            "rationale": "",
            "evidence": [],
            "error": _safe_judge_string(type(exc).__name__, reference, 200),
        }
    if completed.returncode != 0:
        return {
            "enabled": True,
            "status": "judge_error",
            "model": config["model"],
            "verdict": "judge_uncertain",
            "rationale": "",
            "evidence": [],
            "error": f"judge command exited with code {completed.returncode}",
        }
    try:
        payload = _extract_json_object(completed.stdout)
        return _normalise_pairwise_payload(payload, reference, config["model"])
    except (json.JSONDecodeError, ValueError, TypeError) as exc:
        return {
            "enabled": True,
            "status": "judge_error",
            "model": config["model"],
            "verdict": "judge_uncertain",
            "rationale": "",
            "evidence": [],
            "error": _safe_judge_string(str(exc), reference, 300),
        }


def _swap_pairwise_verdict(verdict: str) -> str:
    return {"A_better": "B_better", "B_better": "A_better"}.get(verdict, verdict)


def score_pairwise_llm_judge(
    baseline_case: Dict[str, Any],
    baseline_variant: str,
    candidate_case: Dict[str, Any],
    candidate_variant: str,
    prepared_dir: Optional[Path],
    llm_judge: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    config = _normalise_judge_config(llm_judge)
    if config is None:
        return {"enabled": False, "status": "not_applicable"}
    baseline_reference = _raw_case_reference_for_case(baseline_case, prepared_dir)
    candidate_reference = _raw_case_reference_for_case(candidate_case, prepared_dir)
    if baseline_reference != candidate_reference:
        return {
            "enabled": True,
            "status": "not_applicable",
            "model": config["model"],
            "verdict": "judge_uncertain",
            "rationale": "",
            "evidence": [],
            "error": "pairwise submissions do not share identical scoring reference provenance",
        }
    prompt, reference, prompt_error = _build_pairwise_judge_prompt(
        baseline_case,
        baseline_variant,
        candidate_case,
        candidate_variant,
        prepared_dir,
        config["max_chars"],
    )
    if prompt_error or prompt is None:
        return {
            "enabled": True,
            "status": "not_applicable",
            "model": config["model"],
            "verdict": "judge_uncertain",
            "rationale": "",
            "evidence": [],
            "error": prompt_error,
        }
    original = _run_pairwise_judge_command(prompt, reference, config)
    if not config.get("position_swap"):
        return original

    swapped_prompt, _, swapped_prompt_error = _build_pairwise_judge_prompt(
        candidate_case,
        candidate_variant,
        baseline_case,
        baseline_variant,
        prepared_dir,
        config["max_chars"],
    )
    if swapped_prompt_error or swapped_prompt is None:
        swapped = {
            "enabled": True,
            "status": "judge_error",
            "model": config["model"],
            "verdict": "judge_uncertain",
            "rationale": "",
            "evidence": [],
            "error": swapped_prompt_error,
        }
        raw_swapped_verdict = "judge_uncertain"
    else:
        swapped = _run_pairwise_judge_command(swapped_prompt, reference, config)
        raw_swapped_verdict = str(swapped.get("verdict") or "judge_uncertain")
        swapped["verdict"] = _swap_pairwise_verdict(raw_swapped_verdict)

    position_checks = [
        {**original, "position": "candidate_as_B", "raw_verdict": original.get("verdict")},
        {**swapped, "position": "candidate_as_A", "raw_verdict": raw_swapped_verdict},
    ]
    errors = list(dict.fromkeys(str(item.get("error")) for item in (original, swapped) if item.get("error")))
    if errors:
        return {
            "enabled": True,
            "status": "judge_error",
            "model": config["model"],
            "verdict": "judge_uncertain",
            "rationale": "",
            "evidence": [],
            "error": "; ".join(errors),
            "position_checks": position_checks,
        }
    if original.get("verdict") != swapped.get("verdict"):
        return {
            "enabled": True,
            "status": "judge_uncertain",
            "model": config["model"],
            "verdict": "judge_uncertain",
            "rationale": "Position-swapped judgments disagreed.",
            "evidence": [],
            "error": None,
            "position_checks": position_checks,
        }
    combined = dict(original)
    combined["position_checks"] = position_checks
    combined["evidence"] = list(dict.fromkeys((original.get("evidence") or []) + (swapped.get("evidence") or [])))[:8]
    return combined


def _aggregate_pairwise_judgments(judgments: List[Dict[str, Any]]) -> Dict[str, Any]:
    enabled = [judgment for judgment in judgments if judgment.get("enabled")]
    wins = sum(1 for judgment in enabled if judgment.get("verdict") == "B_better")
    losses = sum(1 for judgment in enabled if judgment.get("verdict") == "A_better")
    ties = sum(1 for judgment in enabled if judgment.get("verdict") == "tie")
    both_bad = sum(1 for judgment in enabled if judgment.get("verdict") == "both_bad")
    uncertain = sum(1 for judgment in enabled if judgment.get("verdict") == "judge_uncertain")
    judged_pairs = wins + losses + ties
    win_rate = round((wins + 0.5 * ties) / judged_pairs, 4) if judged_pairs else None
    return {
        "judged_pairs": judged_pairs,
        "wins": wins,
        "losses": losses,
        "ties": ties,
        "both_bad": both_bad,
        "judge_uncertain": uncertain,
        "judge_error_count": sum(1 for judgment in enabled if judgment.get("status") == "judge_error"),
        "win_rate": win_rate,
    }


def score_case(
    case: Dict[str, Any],
    variant: str,
    prepared_dir: Optional[Path] = None,
    llm_judge: Optional[Dict[str, Any]] = None,
    strict_provenance: bool = False,
    current_dataset_hash: Optional[str] = None,
) -> Dict[str, Any]:
    """Compute deterministic scores for one case result."""
    scenario_id = str(case.get("scenario_id") or case.get("case_id") or "")
    case_id = str(case.get("case_id") or scenario_id)
    failure_profile = _case_failure_profile(case, variant)
    provenance = _validate_case_provenance(case, prepared_dir, current_dataset_hash)
    if strict_provenance and not provenance.get("verified"):
        raise ValueError(
            f"Unverified run provenance for {scenario_id} ({variant}): {provenance.get('reason') or provenance.get('status')}"
        )
    result_path = case.get("_result_path")
    scored = {
        "scenario_id": scenario_id,
        "case_id": case_id,
        "variant": variant,
        "reference": _case_reference(case, prepared_dir),
        "provenance": provenance,
        "metrics": {
            "contract_compliance": score_contract_compliance(case, variant, prepared_dir),
            "test_runnable_rate": score_test_runnable_rate(case, variant, prepared_dir),
            "test_pass_rate": score_test_pass_rate(case, variant, prepared_dir),
            "requirement_rule_coverage": score_requirement_rule_coverage(case, variant, prepared_dir),
            "memory_content_quality": score_memory_content_quality(case, variant, prepared_dir),
        },
        "failure_profile": {"reason_codes": failure_profile["reason_codes"]},
        "artifacts": {
            "result_json": str(result_path) if result_path else None,
            "final_diff": case.get("final_diff"),
            "final_memory_snapshot": case.get("final_memory_snapshot"),
            "final_openviking_snapshot": case.get("final_openviking_snapshot"),
        },
    }
    backend_health = score_openviking_backend_health(case, variant)
    if backend_health:
        scored["openviking_backend_health"] = backend_health
    return scored


def _aggregate_metric(case_scores: List[Dict[str, Any]], metric_name: str) -> Dict[str, Any]:
    metrics = [case["metrics"][metric_name] for case in case_scores]
    numeric = [metric for metric in metrics if metric.get("score") is not None]
    return {
        "mean": round(sum(metric["score"] for metric in numeric) / len(numeric), 4) if numeric else None,
        "confidence_mean": round(sum(metric.get("confidence") or 0.0 for metric in numeric) / len(numeric), 4)
        if numeric
        else 0.0,
        "case_count": len(metrics),
        "numeric_count": len(numeric),
        "pass_count": sum(1 for metric in metrics if metric.get("status") == "pass"),
        "partial_count": sum(1 for metric in metrics if metric.get("status") == "partial"),
        "fail_count": sum(1 for metric in metrics if metric.get("status") == "fail"),
        "not_applicable_count": sum(1 for metric in metrics if metric.get("status") == "not_applicable"),
    }


def _aggregate_health(case_scores: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    health_cases = [case.get("openviking_backend_health") for case in case_scores if case.get("openviking_backend_health")]
    if not health_cases:
        return None
    aggregate = {}
    for key in OPENVIKING_HEALTH_KEYS:
        metrics = [health[key] for health in health_cases if key in health]
        numeric = [metric for metric in metrics if metric.get("score") is not None]
        aggregate[key] = {
            "mean": round(sum(metric["score"] for metric in numeric) / len(numeric), 4) if numeric else None,
            "pass_count": sum(1 for metric in metrics if metric.get("status") == "pass"),
            "partial_count": sum(1 for metric in metrics if metric.get("status") == "partial"),
            "fail_count": sum(1 for metric in metrics if metric.get("status") == "fail"),
            "not_applicable_count": sum(1 for metric in metrics if metric.get("status") == "not_applicable"),
            "evidence": [item for metric in metrics for item in (metric.get("evidence") or [])[:2]][:8],
        }
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




def _aggregate_test_result_status(cases: List[Dict[str, Any]]) -> Dict[str, Any]:
    environment: Counter = Counter()
    integrity: Counter = Counter()
    status: Counter = Counter()
    cases_detail = []
    for case in cases:
        test_result = case.get("test_result") or {}
        if not isinstance(test_result, dict) or not test_result:
            environment["missing_test_result"] += 1
            integrity["missing_test_result"] += 1
            status["missing_test_result"] += 1
            continue
        env_status = str(test_result.get("environment_status") or "unknown")
        integrity_status = str(test_result.get("integrity_status") or "unknown")
        result_status = str(test_result.get("status") or "unknown")
        environment[env_status] += 1
        integrity[integrity_status] += 1
        status[result_status] += 1
        cases_detail.append(
            {
                "scenario_id": case.get("scenario_id"),
                "case_id": case.get("case_id"),
                "status": result_status,
                "environment_status": env_status,
                "integrity_status": integrity_status,
                "failure_classification": test_result.get("failure_classification"),
                "reason": test_result.get("reason") or test_result.get("integrity_reason"),
            }
        )
    return {
        "status_distribution": dict(status),
        "environment_distribution": dict(environment),
        "integrity_distribution": dict(integrity),
        "cases": cases_detail,
    }


def summarize_variant(
    run_dir: Path,
    prepared_dir: Optional[Path] = None,
    llm_judge: Optional[Dict[str, Any]] = None,
    case_results: Optional[List[Dict[str, Any]]] = None,
    case_scores: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Summarize quality, operational status, efficiency, and debug evidence for a variant."""
    cases = case_results if case_results is not None else collect_case_results(run_dir)
    variant = _variant_from_run(run_dir, cases)
    sessions = [session for case in cases for session in case.get("sessions", [])]
    error_sessions = [session for session in sessions if session.get("is_error") or session.get("exit_code") != 0]
    if case_scores is None:
        case_scores = [score_case(case, variant, prepared_dir) for case in cases]
    cli_completed_cases = sum(
        1
        for case in cases
        if case.get("sessions")
        and not case.get("errors")
        and all(not session.get("is_error") and session.get("exit_code") == 0 for session in case.get("sessions", []))
    )
    test_valid_cases = sum(1 for case in cases if _test_result_is_runnable_valid(case.get("test_result") or {}))
    task_passed_cases = sum(
        1
        for case in cases
        if _test_result_is_runnable_valid(case.get("test_result") or {})
        and (
            str((case.get("test_result") or {}).get("status") or "") == "passed"
            or (case.get("test_result") or {}).get("exit_code") == 0
        )
    )
    summary = {
        "run_dir": str(run_dir),
        "case_count": len(cases),
        "session_count": len(sessions),
        "error_session_count": len(error_sessions),
        "run_completion": {
            "result_files": len(cases),
            "completed_cases": cli_completed_cases,
            "cli_completed_cases": cli_completed_cases,
            "test_valid_cases": test_valid_cases,
            "task_passed_cases": task_passed_cases,
            "error_sessions": len(error_sessions),
            "sessions": len(sessions),
        },
        "token_totals": _sum_token_totals(sessions),
        "tool_totals": _sum_tool_totals(cases),
        "metrics": {metric_name: _aggregate_metric(case_scores, metric_name) for metric_name in CORE_DETERMINISTIC_METRICS},
        "failure_profile": _aggregate_failure_profiles(cases, variant),
        "test_result_status": _aggregate_test_result_status(cases),
        "provenance_status": dict(Counter((case.get("provenance") or {}).get("status") or "missing" for case in case_scores)),
    }
    health = _aggregate_health(case_scores)
    if health is not None:
        summary["openviking_backend_health"] = health
    return summary


def _delta(candidate_values: Dict[str, Any], baseline_values: Dict[str, Any], key: str) -> Any:
    return candidate_values.get(key, 0) - baseline_values.get(key, 0)


def _normalise_variant_name(name: str) -> str:
    aliases = {
        "on": "memory_on",
        "off": "memory_off",
        "native": "native_memory_on",
        "openviking": "openviking_on",
    }
    return aliases.get(str(name or ""), str(name or ""))


def _variant_from_run(run_dir: Path, case_results: Optional[List[Dict[str, Any]]] = None) -> str:
    if case_results:
        variants = [case.get("variant") for case in case_results if case.get("variant")]
        if variants and all(variant == variants[0] for variant in variants):
            return _normalise_variant_name(str(variants[0]))
    return _normalise_variant_name(run_dir.name)


def _percent_delta(delta: Optional[float], baseline: Optional[float]) -> Optional[float]:
    if delta is None or baseline in (None, 0):
        return None
    return round((delta / baseline) * 100, 2)


def _format_value(value: Any, digits: int = 2) -> str:
    if value is None:
        return "N/A"
    if isinstance(value, int):
        return f"{value:,}"
    if isinstance(value, float):
        if value.is_integer():
            return f"{int(value):,}"
        return f"{value:,.{digits}f}"
    return str(value)


def _format_delta(value: Any, digits: int = 2) -> str:
    if value is None:
        return "N/A"
    if isinstance(value, (int, float)):
        sign = "+" if value > 0 else ""
        return sign + _format_value(value, digits)
    return str(value)


def _format_percent(value: Optional[float]) -> str:
    if value is None:
        return "N/A"
    sign = "+" if value > 0 else ""
    return f"{sign}{value:.2f}%"


def _metric_mean(summary: Dict[str, Any], metric_name: str) -> Optional[float]:
    return (((summary.get("metrics") or {}).get(metric_name) or {}).get("mean"))


def _metric_delta(candidate: Dict[str, Any], baseline: Dict[str, Any], metric_name: str) -> Optional[float]:
    candidate_value = ((candidate.get("metrics") or {}).get(metric_name) or {}).get("mean")
    baseline_value = ((baseline.get("metrics") or {}).get(metric_name) or {}).get("mean")
    if candidate_value is None or baseline_value is None:
        return None
    return round(candidate_value - baseline_value, 4)


def compute_deltas(candidate: Optional[Dict[str, Any]], baseline: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Compute candidate - baseline efficiency and core quality deltas."""
    if not candidate or not baseline:
        return {}
    candidate_tokens = candidate["token_totals"]
    baseline_tokens = baseline["token_totals"]
    candidate_tools = candidate.get("tool_totals") or {}
    baseline_tools = baseline.get("tool_totals") or {}
    deltas = {
        "input_token_delta": _delta(candidate_tokens, baseline_tokens, "input_tokens"),
        "output_token_delta": _delta(candidate_tokens, baseline_tokens, "output_tokens"),
        "cache_creation_input_token_delta": _delta(candidate_tokens, baseline_tokens, "cache_creation_input_tokens"),
        "cache_read_input_token_delta": _delta(candidate_tokens, baseline_tokens, "cache_read_input_tokens"),
        "new_input_output_token_delta": _delta(candidate_tokens, baseline_tokens, "new_input_output_tokens"),
        "total_reported_token_delta": _delta(candidate_tokens, baseline_tokens, "total_reported_tokens"),
        "cost_delta_usd": _delta(candidate_tokens, baseline_tokens, "total_cost_usd"),
        "duration_delta_ms": _delta(candidate_tokens, baseline_tokens, "duration_ms"),
        "duration_api_delta_ms": _delta(candidate_tokens, baseline_tokens, "duration_api_ms"),
        "duration_sec_delta": _delta(candidate_tokens, baseline_tokens, "duration_sec"),
    }
    for key in TOOL_COMPARISON_KEYS:
        deltas[f"{key}_delta"] = _delta(candidate_tools, baseline_tools, key)
    for metric_name in CORE_DETERMINISTIC_METRICS:
        deltas[f"{metric_name}_delta"] = _metric_delta(candidate, baseline, metric_name)
    return deltas


def _case_map(cases: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    return {str(case.get("scenario_id") or case.get("case_id") or ""): case for case in cases}


def _comparison_specs(variants: Dict[str, Any]) -> List[Tuple[str, str, str]]:
    specs = []
    if "memory_off" in variants and "native_memory_on" in variants:
        specs.append(("memory_off_vs_native_memory_on", "memory_off", "native_memory_on"))
    elif "memory_off" in variants and "memory_on" in variants:
        specs.append(("memory_off_vs_memory_on", "memory_off", "memory_on"))
    if "memory_off" in variants and "openviking_on" in variants:
        specs.append(("memory_off_vs_openviking_on", "memory_off", "openviking_on"))
    if "native_memory_on" in variants and "openviking_on" in variants:
        specs.append(("native_memory_on_vs_openviking_on", "native_memory_on", "openviking_on"))
    return specs


def _pairwise_judge_for_comparison(
    baseline_name: str,
    candidate_name: str,
    raw_cases: Dict[str, List[Dict[str, Any]]],
    prepared_dir: Optional[Path],
    llm_judge: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    baseline_cases = _case_map(raw_cases.get(baseline_name) or [])
    candidate_cases = _case_map(raw_cases.get(candidate_name) or [])
    common_ids = sorted(set(baseline_cases) & set(candidate_cases))
    judgments = []
    for scenario_id in common_ids:
        judgment = score_pairwise_llm_judge(
            baseline_cases[scenario_id],
            baseline_name,
            candidate_cases[scenario_id],
            candidate_name,
            prepared_dir,
            llm_judge,
        )
        judgment.update({"scenario_id": scenario_id})
        judgments.append(judgment)
    return {
        "summary": _aggregate_pairwise_judgments(judgments),
        "cases": judgments,
    }


def render_markdown_report(report: Dict[str, Any]) -> str:
    """Render the default markdown report next to the JSON score output."""
    return render_readable_report(report)


def score_runs(
    run_dirs: List[Path],
    output: Path,
    prepared_dir: Optional[Path] = None,
    llm_judge: Optional[Dict[str, Any]] = None,
    progress: Optional[Callable[[str], None]] = None,
    strict_provenance: bool = False,
) -> Dict[str, Any]:
    """Score one or more variant run directories and write JSON/Markdown reports."""
    prepared_dir = prepared_dir.resolve() if prepared_dir is not None else None
    llm_judge = _normalise_judge_config(llm_judge)
    current_dataset_hash = sha256_prepared_dataset(prepared_dir) if prepared_dir is not None else None
    variants = {}
    cases = []
    raw_cases_by_variant: Dict[str, List[Dict[str, Any]]] = {}
    observed_dataset_hashes = set()
    observed_case_hashes: Dict[str, set] = {}
    for run_dir in run_dirs:
        if progress:
            progress(f"Scoring variant {run_dir.name}: collecting cases")
        case_results = collect_case_results(run_dir)
        variant = _variant_from_run(run_dir, case_results)
        raw_cases_by_variant[variant] = case_results
        if progress:
            progress(f"Scoring variant {variant}: {len(case_results)} case(s)")
        case_scores = []
        for index, case in enumerate(case_results, start=1):
            scenario_id = case.get("scenario_id") or case.get("case_id") or "unknown"
            if progress:
                progress(f"Scoring variant {variant}: case {index}/{len(case_results)} {scenario_id}")
            case_score = score_case(
                case,
                variant,
                prepared_dir,
                strict_provenance=strict_provenance,
                current_dataset_hash=current_dataset_hash,
            )
            case_scores.append(case_score)
            provenance = case_score.get("provenance") or {}
            if provenance.get("verified"):
                if provenance.get("prepared_dataset_sha256"):
                    observed_dataset_hashes.add(str(provenance["prepared_dataset_sha256"]))
                if provenance.get("prepared_case_sha256"):
                    observed_case_hashes.setdefault(str(scenario_id), set()).add(
                        str(provenance["prepared_case_sha256"])
                    )
        variants[variant] = summarize_variant(run_dir, prepared_dir, None, case_results, case_scores)
        cases.extend(case_scores)

    conflicting_cases = sorted(scenario_id for scenario_id, hashes in observed_case_hashes.items() if len(hashes) > 1)
    if strict_provenance and (len(observed_dataset_hashes) != 1 or conflicting_cases):
        details = []
        if len(observed_dataset_hashes) != 1:
            details.append(f"dataset_hashes={sorted(observed_dataset_hashes)}")
        if conflicting_cases:
            details.append(f"conflicting_case_hashes={conflicting_cases}")
        raise ValueError("Run inputs do not share one prepared provenance: " + ", ".join(details))

    comparisons: Dict[str, Dict[str, Any]] = {}
    for name, baseline_name, candidate_name in _comparison_specs(variants):
        comparison = {
            "baseline": baseline_name,
            "candidate": candidate_name,
            "deltas": compute_deltas(variants.get(candidate_name), variants.get(baseline_name)),
        }
        if llm_judge:
            comparison["blind_llm_pairwise"] = _pairwise_judge_for_comparison(
                baseline_name,
                candidate_name,
                raw_cases_by_variant,
                prepared_dir,
                llm_judge,
            )
        comparisons[name] = comparison
    legacy_deltas = (comparisons.get("memory_off_vs_memory_on") or {}).get("deltas") or {}
    report = {
        "schema_version": SCHEMA_VERSION,
        "prepared_dir": str(prepared_dir) if prepared_dir else None,
        "provenance_policy": "strict" if strict_provenance else "compatibility",
        "prepared_dataset_sha256": current_dataset_hash
        or (next(iter(observed_dataset_hashes)) if len(observed_dataset_hashes) == 1 else None),
        "run_prepared_dataset_sha256": next(iter(observed_dataset_hashes)) if len(observed_dataset_hashes) == 1 else None,
        "run_prepared_dataset_hashes": sorted(observed_dataset_hashes),
        "dataset_stats": _load_dataset_stats(prepared_dir),
        "llm_judge_enabled": bool(llm_judge),
        "variants": variants,
        "cases": cases,
        "deltas": legacy_deltas,
        "comparisons": comparisons,
    }
    if progress:
        progress(f"Writing report to {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    write_json(output, report)
    markdown = output.with_suffix(".md")
    markdown.parent.mkdir(parents=True, exist_ok=True)
    markdown.write_text(render_markdown_report(report), encoding="utf-8")
    readable = output.parent / "readable_report.md"
    readable.write_text(render_readable_report(report), encoding="utf-8")
    if progress:
        progress(f"Writing readable report to {readable}")
    return report


def _zh_metric_name(metric_name: str) -> str:
    names = {
        "contract_compliance": "Contract 遵从率",
        "test_runnable_rate": "测试可运行率",
        "test_pass_rate": "可运行测试通过率",
        "requirement_rule_coverage": "需求规则覆盖率",
        "memory_content_quality": "Memory 内容质量",
        "capture_state": "OpenViking capture state",
        "recall_state": "OpenViking recall state",
        "context_injection_state": "OpenViking context injection state",
        "isolation_state": "OpenViking isolation state",
        "input_tokens": "输入 tokens",
        "output_tokens": "输出 tokens",
        "new_input_output_tokens": "新增输入输出 tokens",
        "total_reported_tokens": "总 reported tokens",
        "total_cost_usd": "总成本 USD",
        "duration_sec": "Agent 执行耗时秒数",
        "tool_call_count": "工具调用总数",
        "search_or_read_tool_call_count": "搜索/读文件工具调用数",
        "bash_tool_call_count": "Bash 调用数",
        "edit_tool_call_count": "编辑工具调用数",
        "memory_tool_call_count": "显式 Memory 工具调用数",
    }
    return names.get(metric_name, metric_name)



def _metric_conclusion(delta: Optional[float]) -> str:
    if delta is None:
        return "不可比较"
    if delta > 0:
        return "candidate 更高"
    if delta < 0:
        return "baseline 更高"
    return "两边相同"


def _display_comparisons(report: Dict[str, Any]) -> List[Tuple[str, Dict[str, Any]]]:
    comparisons = report.get("comparisons") or {}
    order = [
        "memory_off_vs_native_memory_on",
        "memory_off_vs_memory_on",
        "memory_off_vs_openviking_on",
        "native_memory_on_vs_openviking_on",
    ]
    return [(name, comparisons[name]) for name in order if comparisons.get(name)]


def _append_distribution_table(lines: List[str], title: str, distribution: Dict[str, int]) -> None:
    lines.extend([f"### {title}", ""])
    lines.extend(["| Value | Count |", "| --- | ---: |"])
    if distribution:
        for key, count in sorted(distribution.items(), key=lambda item: (-item[1], item[0])):
            lines.append(f"| `{key}` | {count} |")
    else:
        lines.append("| N/A | 0 |")
    lines.append("")


def _append_core_metric_table(lines: List[str], comparison_name: str, comparison: Dict[str, Any], variants: Dict[str, Any]) -> None:
    baseline_name = comparison.get("baseline")
    candidate_name = comparison.get("candidate")
    baseline = variants.get(baseline_name) or {}
    candidate = variants.get(candidate_name) or {}
    deltas = comparison.get("deltas") or {}
    lines.extend([f"### {comparison_name}", ""])
    lines.extend([
        f"| Metric | 中文名称 | {candidate_name} | {baseline_name} | Delta = {candidate_name} - {baseline_name} | Delta % vs {baseline_name} | 说明 |",
        "| --- | --- | ---: | ---: | ---: | ---: | --- |",
    ])
    for metric_name in CORE_DETERMINISTIC_METRICS:
        candidate_value = _metric_mean(candidate, metric_name)
        baseline_value = _metric_mean(baseline, metric_name)
        delta = deltas.get(f"{metric_name}_delta")
        percent = _percent_delta(delta, baseline_value)
        lines.append(
            f"| `{metric_name}` | {_zh_metric_name(metric_name)} | {_format_value(candidate_value)} | {_format_value(baseline_value)} | {_format_delta(delta)} | {_format_percent(percent)} | {_metric_conclusion(delta)} |"
        )
    lines.append("")


def _append_efficiency_table(lines: List[str], comparison_name: str, comparison: Dict[str, Any], variants: Dict[str, Any]) -> None:
    baseline_name = comparison.get("baseline")
    candidate_name = comparison.get("candidate")
    baseline = variants.get(baseline_name) or {}
    candidate = variants.get(candidate_name) or {}
    deltas = comparison.get("deltas") or {}
    lines.extend([f"### {comparison_name}", ""])
    lines.extend([
        f"| Metric | 中文名称 | {candidate_name} | {baseline_name} | Delta = {candidate_name} - {baseline_name} | Delta % vs {baseline_name} |",
        "| --- | --- | ---: | ---: | ---: | ---: |",
    ])
    token_delta_names = {
        "input_tokens": "input_token_delta",
        "output_tokens": "output_token_delta",
        "new_input_output_tokens": "new_input_output_token_delta",
        "total_reported_tokens": "total_reported_token_delta",
        "total_cost_usd": "cost_delta_usd",
        "duration_sec": "duration_sec_delta",
    }
    for key in TOKEN_COMPARISON_KEYS:
        candidate_value = (candidate.get("token_totals") or {}).get(key)
        baseline_value = (baseline.get("token_totals") or {}).get(key)
        delta = deltas.get(token_delta_names[key])
        digits = 6 if key == "total_cost_usd" else 2
        lines.append(
            f"| `{key}` | {_zh_metric_name(key)} | {_format_value(candidate_value, digits)} | {_format_value(baseline_value, digits)} | {_format_delta(delta, digits)} | {_format_percent(_percent_delta(delta, baseline_value))} |"
        )
    for key in TOOL_COMPARISON_KEYS:
        candidate_value = (candidate.get("tool_totals") or {}).get(key)
        baseline_value = (baseline.get("tool_totals") or {}).get(key)
        delta = deltas.get(f"{key}_delta")
        lines.append(
            f"| `{key}` | {_zh_metric_name(key)} | {_format_value(candidate_value)} | {_format_value(baseline_value)} | {_format_delta(delta)} | {_format_percent(_percent_delta(delta, baseline_value))} |"
        )
    lines.append("")


def _variant_value(summary: Dict[str, Any], metric_name: str) -> Optional[float]:
    return _metric_mean(summary, metric_name)


def _baseline_candidate_names(variants: Dict[str, Any]) -> Tuple[Optional[str], List[str]]:
    baseline = "memory_off" if "memory_off" in variants else None
    if baseline is None:
        return None, [name for name in variants if name != baseline]
    candidates = []
    for name in ("native_memory_on", "memory_on", "openviking_on"):
        if name in variants and name != baseline:
            candidates.append(name)
    for name in variants:
        if name != baseline and name not in candidates:
            candidates.append(name)
    return baseline, candidates


def _append_baseline_metric_matrix(lines: List[str], variants: Dict[str, Any]) -> None:
    baseline_name, candidates = _baseline_candidate_names(variants)
    if baseline_name is None or not candidates:
        lines.append("没有可展示的 baseline comparison。")
        lines.append("")
        return
    header = ["Metric", "中文名称", baseline_name]
    for candidate in candidates:
        header.extend([candidate, f"{candidate} Δ vs {baseline_name}"])
    header.append("说明")
    lines.append("| " + " | ".join(header) + " |")
    lines.append("| " + " | ".join(["---", "---"] + ["---:"] * (len(header) - 3) + ["---"]) + " |")
    baseline = variants.get(baseline_name) or {}
    for metric_name in CORE_DETERMINISTIC_METRICS:
        baseline_value = _variant_value(baseline, metric_name)
        row = [f"`{metric_name}`", _zh_metric_name(metric_name), _format_value(baseline_value)]
        notes = []
        for candidate_name in candidates:
            candidate = variants.get(candidate_name) or {}
            candidate_value = _variant_value(candidate, metric_name)
            delta = None if candidate_value is None or baseline_value is None else round(candidate_value - baseline_value, 4)
            row.extend([_format_value(candidate_value), _format_delta(delta)])
            if delta is None:
                notes.append(f"{candidate_name} 不可比较")
            elif delta > 0:
                notes.append(f"{candidate_name} 更高")
            elif delta < 0:
                notes.append(f"{candidate_name} 更低")
        row.append("；".join(notes) if notes else "三组相同或无显著差异")
        lines.append("| " + " | ".join(row) + " |")
    lines.append("")


def _append_baseline_efficiency_matrix(lines: List[str], variants: Dict[str, Any]) -> None:
    baseline_name, candidates = _baseline_candidate_names(variants)
    if baseline_name is None or not candidates:
        lines.append("没有可展示的 baseline efficiency comparison。")
        lines.append("")
        return
    header = ["Metric", "中文名称", baseline_name]
    for candidate in candidates:
        header.extend([candidate, f"{candidate} Δ vs {baseline_name}"])
    lines.append("| " + " | ".join(header) + " |")
    lines.append("| " + " | ".join(["---", "---"] + ["---:"] * (len(header) - 2)) + " |")
    baseline = variants.get(baseline_name) or {}
    for key in list(TOKEN_COMPARISON_KEYS) + list(TOOL_COMPARISON_KEYS):
        source = "tool_totals" if key in TOOL_COMPARISON_KEYS else "token_totals"
        digits = 6 if key == "total_cost_usd" else 2
        baseline_value = (baseline.get(source) or {}).get(key)
        row = [f"`{key}`", _zh_metric_name(key), _format_value(baseline_value, digits)]
        for candidate_name in candidates:
            candidate_value = ((variants.get(candidate_name) or {}).get(source) or {}).get(key)
            delta = None if candidate_value is None or baseline_value is None else candidate_value - baseline_value
            row.extend([_format_value(candidate_value, digits), _format_delta(delta, digits)])
        lines.append("| " + " | ".join(row) + " |")
    lines.append("")


def _metric_na_reasons(report: Dict[str, Any]) -> Dict[str, Counter]:
    reasons: Dict[str, Counter] = {metric: Counter() for metric in CORE_DETERMINISTIC_METRICS}
    for case in report.get("cases") or []:
        for metric_name, metric in (case.get("metrics") or {}).items():
            if metric.get("status") != "not_applicable":
                continue
            evidence = metric.get("evidence") or ["not_applicable"]
            reasons.setdefault(metric_name, Counter())[str(evidence[0])] += 1
    return reasons


def _append_na_reason_section(lines: List[str], report: Dict[str, Any]) -> None:
    lines.extend(["## N/A 原因说明", ""])
    stats = report.get("dataset_stats") or {}
    if stats.get("test_plan_stats"):
        _append_distribution_table(lines, "Test plan 状态分布", stats.get("test_plan_stats") or {})
    variants = report.get("variants") or {}
    if variants:
        lines.extend(["### Post-run test environment / integrity", ""])
        lines.extend(["| Variant | Result statuses | Environment statuses | Integrity statuses |", "| --- | --- | --- | --- |"])
        excluded_rows = []
        for variant_name, summary in variants.items():
            status = summary.get("test_result_status") or {}
            result_dist = ", ".join(f"`{key}`={value}" for key, value in sorted((status.get("status_distribution") or {}).items())) or "N/A"
            env_dist = ", ".join(f"`{key}`={value}" for key, value in sorted((status.get("environment_distribution") or {}).items())) or "N/A"
            integrity_dist = ", ".join(f"`{key}`={value}" for key, value in sorted((status.get("integrity_distribution") or {}).items())) or "N/A"
            lines.append(f"| `{variant_name}` | {result_dist} | {env_dist} | {integrity_dist} |")
            for item in status.get("cases") or []:
                if item.get("environment_status") not in {"ready", "not_checked"} or item.get("integrity_status") == "failed" or item.get("status") in {"invalid", "timeout"}:
                    excluded_rows.append((variant_name, item))
        lines.append("")
        if excluded_rows:
            lines.extend(["#### Post-run test excluded / invalid case 明细", ""])
            lines.extend(["| Variant | Case | Status | Environment | Integrity | Reason |", "| --- | --- | --- | --- | --- | --- |"])
            for variant_name, item in excluded_rows[:50]:
                case_name = item.get("case_id") or item.get("scenario_id") or "unknown"
                reason = item.get("reason") or item.get("failure_classification") or "N/A"
                lines.append(
                    f"| `{variant_name}` | `{case_name}` | `{item.get('status')}` | `{item.get('environment_status')}` | `{item.get('integrity_status')}` | {reason} |"
                )
            if len(excluded_rows) > 50:
                lines.append(f"| ... | ... | ... | ... | ... | 仅展示前 50 条，共 {len(excluded_rows)} 条 |")
            lines.append("")
    requirement_stats = stats.get("requirement_check_stats") or {}
    if requirement_stats.get("status_distribution"):
        _append_distribution_table(lines, "Requirement checks 状态分布", requirement_stats.get("status_distribution") or {})
    if requirement_stats.get("source_distribution"):
        _append_distribution_table(lines, "Requirement checks 来源分布", requirement_stats.get("source_distribution") or {})
    if requirement_stats.get("strength_distribution"):
        _append_distribution_table(lines, "Requirement checks 强度分布", requirement_stats.get("strength_distribution") or {})
    if requirement_stats.get("signal_kind_distribution"):
        _append_distribution_table(lines, "Requirement checks signal kind 分布", requirement_stats.get("signal_kind_distribution") or {})
    if requirement_stats.get("rejection_reason_distribution"):
        _append_distribution_table(lines, "Requirement checks rejected term 原因分布", requirement_stats.get("rejection_reason_distribution") or {})
    case_requirement_checks = requirement_stats.get("case_requirement_checks") or []
    if case_requirement_checks:
        lines.extend(["### Requirement check case 明细", ""])
        lines.extend(["| Case | Status | Source | Count | Signal kinds | Strengths | Reason |", "| --- | --- | --- | ---: | --- | --- | --- |"])
        for item in case_requirement_checks[:50]:
            signal_kinds = ", ".join(f"`{value}`" for value in item.get("signal_kinds", [])) or "N/A"
            strengths = ", ".join(f"`{value}`" for value in item.get("strengths", [])) or "N/A"
            lines.append(
                f"| `{item.get('case_id') or item.get('scenario_id')}` | `{item.get('status')}` | `{item.get('source')}` | {item.get('check_count', 0)} | {signal_kinds} | {strengths} | {item.get('reason') or ''} |"
            )
        if len(case_requirement_checks) > 50:
            lines.append(f"| ... | ... | ... | ... | ... | ... | 仅展示前 50 个 case，共 {len(case_requirement_checks)} 个 |")
        lines.append("")
    reasons = _metric_na_reasons(report)
    lines.extend(["### Metric-level N/A evidence", "", "| Metric | Reason | Count |", "| --- | --- | ---: |"])
    any_reason = False
    for metric_name, counter in reasons.items():
        for reason, count in counter.most_common():
            any_reason = True
            lines.append(f"| `{metric_name}` | {reason} | {count} |")
    if not any_reason:
        lines.append("| N/A | 当前报告没有 metric-level N/A | 0 |")
    lines.append("")


def _data_driven_conclusion(report: Dict[str, Any]) -> List[str]:
    variants = report.get("variants") or {}
    baseline_name, candidates = _baseline_candidate_names(variants)
    if not variants:
        return ["本次报告没有可总结的 variant 结果。"]
    total_errors = sum(((summary.get("run_completion") or {}).get("error_sessions", 0) or 0) for summary in variants.values())
    lines = []
    if total_errors == 0:
        lines.append(f"本次 {len(variants)} 组 variant 均完成运行，没有 error session。")
    else:
        lines.append(f"本次运行共有 {total_errors} 个 error session，质量结论需要结合失败 profile 解读。")
    has_test_gating = False
    for summary in variants.values():
        status = summary.get("test_result_status") or {}
        env = status.get("environment_distribution") or {}
        integrity = status.get("integrity_distribution") or {}
        if any(key not in {"ready", "not_checked"} for key in env) or integrity.get("failed", 0):
            has_test_gating = True
            break
    if has_test_gating:
        lines.append("存在 post-run test 环境不可用、测试计划不可解析或 integrity 失败的 case；`test_runnable_rate` 用于展示测试可评测覆盖率，`test_pass_rate` 只在可运行可信测试分母中计算通过率。")
    if baseline_name:
        baseline = variants.get(baseline_name) or {}
        for candidate_name in candidates:
            candidate = variants.get(candidate_name) or {}
            quality_parts = []
            for metric_name in CORE_DETERMINISTIC_METRICS:
                baseline_value = _metric_mean(baseline, metric_name)
                candidate_value = _metric_mean(candidate, metric_name)
                if candidate_value is None or baseline_value is None:
                    continue
                delta = round(candidate_value - baseline_value, 4)
                if delta > 0:
                    quality_parts.append(f"{_zh_metric_name(metric_name)} 提升 {delta}")
                elif delta < 0:
                    quality_parts.append(f"{_zh_metric_name(metric_name)} 下降 {abs(delta)}")
            if quality_parts:
                lines.append(f"{candidate_name} 相对 {baseline_name}：" + "；".join(quality_parts) + "。")
            else:
                lines.append(f"{candidate_name} 相对 {baseline_name}：核心质量指标没有可比较提升，或覆盖不足以下结论。")
            cost_delta = ((candidate.get("token_totals") or {}).get("total_cost_usd") or 0) - ((baseline.get("token_totals") or {}).get("total_cost_usd") or 0)
            token_delta = ((candidate.get("token_totals") or {}).get("total_reported_tokens") or 0) - ((baseline.get("token_totals") or {}).get("total_reported_tokens") or 0)
            lines.append(f"效率方面，{candidate_name} 相对 {baseline_name} total_reported_tokens delta={_format_delta(token_delta)}，cost delta={_format_delta(cost_delta, 6)}。")
    if "openviking_on" in variants:
        health = (variants.get("openviking_on") or {}).get("openviking_backend_health") or {}
        if health:
            pass_count = sum(1 for item in health.values() if item.get("pass_count", 0) > 0)
            lines.append(f"OpenViking backend debug evidence 有 {pass_count}/{len(OPENVIKING_HEALTH_KEYS)} 类 evidence 出现 pass；该证据只说明 backend 工作状态，不直接进入核心质量结论。")
    return lines


def render_readable_report(report: Dict[str, Any], report_date: Optional[str] = None, comparison_name: Optional[str] = None) -> str:
    report_date = report_date or datetime.now().strftime("%Y-%m-%d")
    prepared_dir = report.get("prepared_dir") or "N/A"
    variants = report.get("variants") or {}
    comparisons = _display_comparisons(report)
    comparison_label = "；".join(name for name, _ in comparisons) if comparisons else "N/A"
    lines = [
        "# Memory Eval 可读报告",
        "",
        f"报告日期：{report_date}",
        f"评测数据集：`{prepared_dir}`",
        f"数据血缘策略：`{report.get('provenance_policy') or 'compatibility'}`",
        f"Prepared dataset SHA-256：`{report.get('prepared_dataset_sha256') or 'unverified'}`",
        "评测方向：多 session 软件开发任务中的 memory backend 对比",
        f"对比模式：{comparison_label}",
        "",
        "---",
        "",
        "## 1. 本次运行的产物",
        "",
        "主要产物会和本报告放在同一个 score 输出目录中：",
        "",
        "```text",
        "score_report.json",
        "score_report.md",
        "readable_report.md",
        "```",
        "",
        "Run outputs：",
        "",
        "```text",
    ]
    for name, summary in variants.items():
        lines.append(f"{name}: {summary.get('run_dir')}")
    lines.extend(["```", "", "---", ""])

    lines.extend(["## 2. 数据集基础统计", ""])
    stats = report.get("dataset_stats") or _empty_dataset_stats()
    _append_distribution_table(lines, "难度分布", stats.get("difficulty_distribution") or {})
    task_types = stats.get("task_type_distribution") or {}
    if len(task_types) > 1:
        _append_distribution_table(lines, "任务类型分布", task_types)
    _append_distribution_table(lines, "编程语言分布", stats.get("programming_language_distribution") or {})
    contract_stats = stats.get("contract_stats") or {}
    _append_distribution_table(lines, "每个 case 注入的 contract 数量", contract_stats.get("contracts_per_case_distribution") or {})
    _append_distribution_table(lines, "Contract ID 分布", contract_stats.get("contract_id_distribution") or {})
    _append_distribution_table(lines, "Contract 类型分布", contract_stats.get("contract_category_distribution") or {})
    _append_distribution_table(lines, "Contract memory type 分布", contract_stats.get("contract_memory_type_distribution") or {})
    _append_distribution_table(lines, "每个 case 可检查 memory fact contract 数量", contract_stats.get("memory_fact_contracts_per_case_distribution") or {})
    _append_distribution_table(lines, "每个 case 可检查 workspace contract 数量", contract_stats.get("workspace_checkable_contracts_per_case_distribution") or {})
    case_contracts = contract_stats.get("case_contracts") or []
    if case_contracts:
        lines.extend(["### Case contract 明细", "", "| Case | Contracts | Memory facts | Workspace checks | Contract IDs | Memory types |", "| --- | ---: | ---: | ---: | --- | --- |"])
        for item in case_contracts[:50]:
            contract_ids = ", ".join(f"`{contract_id}`" for contract_id in item.get("contract_ids", [])) or "N/A"
            memory_types = ", ".join(f"`{memory_type}`" for memory_type in item.get("memory_types", [])) or "N/A"
            lines.append(f"| `{item.get('case_id') or item.get('scenario_id')}` | {item.get('contract_count', 0)} | {item.get('memory_fact_contract_count', 0)} | {item.get('workspace_checkable_contract_count', 0)} | {contract_ids} | {memory_types} |")
        if len(case_contracts) > 50:
            lines.append(f"| ... | ... | ... | ... | 仅展示前 50 个 case，共 {len(case_contracts)} 个 | ... |")
        lines.append("")
    lines.append("说明：`contract_compliance` 只检查后续 session 新增或修改的文件，不把引入 session 已写入并被动保留到最终 workspace 的内容算作跨 session 遵从。旧 run 若没有逐 session workspace delta，或 session HOME/XDG 未隔离，会显示 N/A。`memory_content_quality` 使用 `expected_memory_facts` 检查 memory 文件或 OpenViking snapshot。")
    lines.append("")
    _append_distribution_table(lines, "测试文件可用性", stats.get("test_availability_stats") or {})
    lines.append("说明：测试文件可用性只表示项目目录中存在 test-like 文件；`test_runnable_rate` 表示 runtime post-run test 是否真正可执行且 integrity 可信；`test_pass_rate` 表示在可运行测试分母中的通过率。环境不可用、测试计划不可解析或测试目标被弱化时不进入 `test_pass_rate` 分母，并在 N/A 原因中展示。")
    lines.append("")
    lines.extend(["---", ""])

    lines.extend(["## 3. 运行完成情况", ""])
    lines.extend([
        "| Variant | Result files | CLI completed | Valid tests | Task passed | Error sessions | Sessions | Provenance |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ])
    for name, summary in variants.items():
        run_completion = summary.get("run_completion") or {}
        provenance_text = ", ".join(
            f"{status}={count}" for status, count in sorted((summary.get("provenance_status") or {}).items())
        ) or "missing"
        lines.append(
            f"| `{name}` | {run_completion.get('result_files', summary.get('case_count', 0))} | "
            f"{run_completion.get('cli_completed_cases', run_completion.get('completed_cases', 0))} | "
            f"{run_completion.get('test_valid_cases', 0)} | {run_completion.get('task_passed_cases', 0)} | "
            f"{run_completion.get('error_sessions', summary.get('error_session_count', 0))} | "
            f"{run_completion.get('sessions', summary.get('session_count', 0))} | {provenance_text} |"
        )
    lines.append("")
    lines.append("说明：`CLI completed` 只表示 agent session 正常结束；`Valid tests` 表示 post-run test 可运行且 integrity 有效；`Task passed` 才表示有效测试通过，三者不可互换。")
    lines.extend(["", "---", ""])

    lines.extend(["## 4. 核心质量指标", ""])
    _append_baseline_metric_matrix(lines, variants)
    lines.extend(["---", ""])

    if report.get("llm_judge_enabled"):
        lines.extend(["## 5. Blind LLM 辅助判断", ""])
        for name, comparison in comparisons:
            pairwise = (comparison.get("blind_llm_pairwise") or {}).get("summary") or {}
            lines.append(
                f"- `{name}`（candidate=`{comparison.get('candidate')}`，baseline=`{comparison.get('baseline')}`）："
                f"candidate_win_rate={_format_value(pairwise.get('win_rate'), 4)}，candidate_wins={pairwise.get('wins', 0)}，"
                f"candidate_losses={pairwise.get('losses', 0)}，ties={pairwise.get('ties', 0)}，"
                f"both_bad={pairwise.get('both_bad', 0)}，uncertain={pairwise.get('judge_uncertain', 0)}"
            )
        lines.extend(["", "说明：每个 pair 会交换 `Submission A/B` 位置复判；两次归一化 verdict 不一致时记 uncertain。胜率始终以 candidate 为方向。", "", "---", ""])

    efficiency_section = 6 if report.get("llm_judge_enabled") else 5
    lines.extend([f"## {efficiency_section}. 效率指标", ""])
    _append_baseline_efficiency_matrix(lines, variants)
    lines.extend(["说明：delta 统一按 candidate - baseline 计算；质量指标 delta > 0 表示 candidate 更好，token/cost/duration/tool calls 的 delta < 0 表示 candidate 相对 baseline 更省或更快。`duration_sec` 仅统计 agent session 执行时间，不含 memory settle 和 post-run tests；`memory_tool_call_count` 只统计日志中显式命名含 memory/OpenViking 的工具调用，不代表自动 hook 或后台注入次数。Delta % 可由 delta / memory_off baseline 计算；machine-readable JSON 中保留 pairwise delta 明细。", "", "---", ""])

    section = efficiency_section + 1
    _append_na_reason_section(lines, report)
    lines.extend(["---", ""])
    section += 1
    has_openviking = any(name in OPENVIKING_VARIANTS for name in variants)
    if has_openviking:
        lines.extend([f"## {section}. OpenViking backend debug evidence", ""])
        lines.append("该章节只用于 debug backend 是否接好，不参与主指标均值、delta 或加权总结。")
        lines.append("")
        for variant_name, summary in variants.items():
            health = summary.get("openviking_backend_health") or {}
            if not health:
                continue
            lines.append(f"### {variant_name}")
            lines.append("")
            lines.extend(["| Debug evidence | Mean | Pass | Partial | Fail | N/A |", "| --- | ---: | ---: | ---: | ---: | ---: |"])
            for key in OPENVIKING_HEALTH_KEYS:
                item = health.get(key) or {}
                lines.append(
                    f"| `{key}` | {_format_value(item.get('mean'))} | {item.get('pass_count', 0)} | {item.get('partial_count', 0)} | {item.get('fail_count', 0)} | {item.get('not_applicable_count', 0)} |"
                )
            lines.append("")
        lines.extend(["---", ""])
        section += 1

    lines.extend([f"## {section}. 指标解释", ""])
    lines.extend(["| 指标中文名 | 指标统计口径 | 指标计算公式 | 规则 or LLM |", "| --- | --- | --- | --- |"])
    for definition in METRIC_DEFINITIONS:
        lines.append(
            f"| {definition['zh_name']} (`{definition['id']}`) | {definition['definition']} | {definition['formula']} | {definition['method']} |"
        )
    lines.extend(["", "---", ""])

    lines.extend([f"## {section + 1}. 中立总结", ""])
    for conclusion_line in _data_driven_conclusion(report):
        lines.append(conclusion_line)
    lines.append("")
    return "\n".join(lines)
