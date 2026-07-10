"""Prepare LoCoBench-Agent multi-session scenarios for memory evaluation."""

import hashlib
import json
import re
import shlex
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .io import (
    copy_tree_clean,
    read_json,
    sha256_file,
    sha256_prepared_case,
    sha256_prepared_dataset,
    sha256_tree,
    write_json,
    write_jsonl,
)
from .schema import PreparedCase, PreparedTurn

TASK_CATEGORIES = (
    "architectural_understanding",
    "bug_investigation",
    "code_comprehension",
    "cross_file_refactoring",
    "feature_implementation",
    "integration_testing",
    "multi_session_development",
    "security_analysis",
)

SESSION_HEADER_RE = re.compile(
    r"(?im)^\s*\*\*(?:Session|Part)\s+(\d+)(?:\s*[:(][^*]*)?\*\*\s*$"
)

TEST_DIR_NAMES = {"test", "tests", "__tests__", "spec", "specs"}
TEST_FILE_MARKERS = (
    "_test.",
    ".test.",
    ".spec.",
    "test_",
)
TEST_FILE_NAMES = {"pytest.ini", "tox.ini", "phpunit.xml", "jest.config.js", "vitest.config.ts"}
MEMORY_FACT_TEMPLATE_LABELS = {
    "project memory",
    "feedback to remember",
    "user preference",
    "reference memory",
}


def _filter_memory_fact_keywords(keywords: Any) -> List[str]:
    """Remove evaluator template labels from expected memory keyword checks."""
    filtered: List[str] = []
    for item in keywords or []:
        text = str(item).strip()
        if not text or text.lower() in MEMORY_FACT_TEMPLATE_LABELS:
            continue
        if text.lower() not in {existing.lower() for existing in filtered}:
            filtered.append(text)
    return filtered


def extract_case_id(scenario_id: str) -> str:
    """Extract the generated project case id from a scenario id."""
    for task_category in TASK_CATEGORIES:
        marker = f"_{task_category}_"
        if marker in scenario_id:
            return scenario_id[: scenario_id.index(marker)]
    parts = scenario_id.split("_")
    return "_".join(parts[:4]) if len(parts) >= 4 else scenario_id


def is_memory_eval_scenario(data: Dict[str, Any], category: str) -> bool:
    """Return true if a scenario belongs in the first-phase memory eval set."""
    original = data.get("original_scenario") or {}
    return (
        data.get("category") == category
        or original.get("task_category") == "multi_session_development"
        or "_multi_session_development_" in str(data.get("scenario_id", ""))
    )


def split_prompt_into_sessions(task_prompt: Any) -> List[str]:
    """Split a LoCoBench multi-session task prompt into benchmark sessions."""
    if isinstance(task_prompt, dict):
        sessions: List[Tuple[int, str]] = []
        for key, value in task_prompt.items():
            match = re.search(r"(\d+)", str(key))
            if match and isinstance(value, str):
                sessions.append((int(match.group(1)), value.strip()))
        return [text for _, text in sorted(sessions)]

    if isinstance(task_prompt, list):
        return [str(item).strip() for item in task_prompt if str(item).strip()]

    prompt = str(task_prompt or "").strip()
    if not prompt:
        return []

    matches = list(SESSION_HEADER_RE.finditer(prompt))
    if not matches:
        return [prompt]

    sessions = []
    prefix = prompt[: matches[0].start()].strip()
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(prompt)
        body = prompt[start:end].strip()
        title = match.group(0).strip()
        text = f"{prefix}\n\n{title}\n{body}".strip() if prefix else f"{title}\n{body}".strip()
        sessions.append(text)
    return sessions


def _normalise_check_list(value: Any) -> List[Dict[str, Any]]:
    return [dict(check) for check in (value or []) if isinstance(check, dict)] if isinstance(value, list) else []


def _normalise_check_map(value: Any) -> Dict[str, List[Dict[str, Any]]]:
    if not isinstance(value, dict):
        return {}
    return {
        str(key).strip().lower(): _normalise_check_list(checks)
        for key, checks in value.items()
        if str(key).strip() and isinstance(checks, list)
    }


def _normalise_contract_list(value: Any) -> List[Dict[str, Any]]:
    return [dict(contract) for contract in (value or []) if isinstance(contract, dict)] if isinstance(value, list) else []


def _normalise_contract_map(value: Any) -> Dict[str, List[Dict[str, Any]]]:
    if not isinstance(value, dict):
        return {}
    return {
        str(key).strip().lower(): _normalise_contract_list(contracts)
        for key, contracts in value.items()
        if str(key).strip() and isinstance(contracts, list)
    }


def _load_contract_overlay(contract_overlay: Optional[Path]) -> Dict[str, Any]:
    """Load optional evaluator-owned memory eval overlay for prepared prompts and scoring."""
    if contract_overlay is None:
        return {
            "memory_contracts": [],
            "language_contracts": {},
            "category_contracts": {},
            "case_contracts": {},
            "requirement_checks": [],
        }
    overlay = read_json(contract_overlay)
    if isinstance(overlay, list):
        return {
            "memory_contracts": _normalise_contract_list(overlay),
            "language_contracts": {},
            "category_contracts": {},
            "case_contracts": {},
            "requirement_checks": [],
        }
    if not isinstance(overlay, dict):
        raise ValueError(f"Unsupported contract overlay shape: {contract_overlay}")
    contracts = overlay.get("memory_contracts") or []
    if not isinstance(contracts, list):
        raise ValueError(f"memory_contracts must be a list: {contract_overlay}")
    for key in ("language_contracts", "category_contracts", "case_contracts"):
        if key in overlay and not isinstance(overlay.get(key), dict):
            raise ValueError(f"{key} must be an object: {contract_overlay}")
    for key in ("language_requirement_checks", "category_requirement_checks", "case_requirement_checks"):
        if key in overlay and not isinstance(overlay.get(key), dict):
            raise ValueError(f"{key} must be an object: {contract_overlay}")
    return {
        **overlay,
        "memory_contracts": _normalise_contract_list(contracts),
        "language_contracts": _normalise_contract_map(overlay.get("language_contracts")),
        "category_contracts": _normalise_contract_map(overlay.get("category_contracts")),
        "case_contracts": _normalise_contract_map(overlay.get("case_contracts")),
        "requirement_checks": _normalise_check_list(overlay.get("requirement_checks")),
        "language_requirement_checks": _normalise_check_map(overlay.get("language_requirement_checks")),
        "category_requirement_checks": _normalise_check_map(overlay.get("category_requirement_checks")),
        "case_requirement_checks": _normalise_check_map(overlay.get("case_requirement_checks")),
    }


def _contracts_for_case(overlay: Dict[str, Any], scenario_id: Any, case_id: Any, language: Any, category: Any) -> List[Dict[str, Any]]:
    """Select the evaluator-owned memory contracts for one case."""
    selected: List[Dict[str, Any]] = []
    seen = set()

    def add_many(items: List[Dict[str, Any]]) -> None:
        for item in items:
            contract_id = str(item.get("id") or "")
            key = contract_id or json.dumps(item, sort_keys=True, ensure_ascii=False)
            if key in seen:
                continue
            seen.add(key)
            selected.append(item)

    add_many(overlay.get("memory_contracts") or [])
    language_key = str(language or "").strip().lower()
    add_many((overlay.get("language_contracts") or {}).get(language_key) or [])
    category_key = str(category or "").strip().lower()
    add_many((overlay.get("category_contracts") or {}).get(category_key) or [])
    case_map = overlay.get("case_contracts") or {}
    scenario_key = str(scenario_id or "").strip().lower()
    case_key = str(case_id or "").strip().lower()
    add_many(case_map.get(scenario_key) or [])
    if case_key != scenario_key:
        add_many(case_map.get(case_key) or [])

    selection = overlay.get("selection") or {}
    try:
        max_contracts = int(selection.get("max_contracts_per_case") or 5)
    except (TypeError, ValueError):
        max_contracts = 5
    return selected[:max(1, max_contracts)]


def _contracts_for_session(contracts: List[Dict[str, Any]], session_index: int) -> List[Dict[str, Any]]:
    """Return contracts introduced in a given session."""
    selected = []
    for contract in contracts:
        introduced = contract.get("introduced_in_session", 1)
        try:
            introduced_session = int(introduced)
        except (TypeError, ValueError):
            introduced_session = 1
        if introduced_session == session_index:
            selected.append(contract)
    return selected


def _natural_contract_description(description: str) -> str:
    """Make evaluator contract descriptions read like ordinary user project notes."""
    text = description.strip()
    prefix_replacements = (
        (r"^Project memory:\s*", ""),
        (r"^Feedback to remember:\s*", ""),
        (r"^User preference:\s*", ""),
        (r"^Reference memory:\s*", ""),
    )
    for pattern, replacement in prefix_replacements:
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    replacements = (
        (r"\bremember which\b", "keep track of which"),
        (r"\bremember\b", "keep track of"),
        (r"\bsave the local files that acted like\b", "use the local files that act like"),
        (r"\bsave a handoff that names\b", "leave a short handoff that names"),
        (r"\bLater sessions should\b", "Continue to"),
    )
    for pattern, replacement in replacements:
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    return text[:1].upper() + text[1:] if text else text


def _contract_prompt_block(contracts: List[Dict[str, Any]]) -> str:
    """Build ordinary project convention notes for one prepared session."""
    if not contracts:
        return ""
    lines = [
        "Also, this repository has the following continuity contracts for implementation work after this session:",
    ]
    for index, contract in enumerate(contracts, start=1):
        description = _natural_contract_description(str(contract.get("description") or ""))
        if description:
            lines.append(f"- {description}")
        else:
            contract_id = str(contract.get("id") or f"project_convention_{index}")
            lines.append(f"- Follow the existing project convention for {contract_id}.")
    lines.append(
        "These contracts apply to relevant code, comment, documentation, helper, handler, adapter, fallback-path, or implementation-note changes in later sessions. "
        "For this session, complete only the current session requirements; do not make unrelated repository edits solely to satisfy continuity contracts that are not relevant to the current work."
    )
    return "\n".join(lines)


def _contract_followup_message(contracts: List[Dict[str, Any]]) -> str:
    """Build a contract-only follow-up turn for the end of session 1."""
    block = _contract_prompt_block(contracts)
    if not block:
        return ""
    return "\n\n".join(
        [
            (
                "Before ending Session 1, record the following continuity contracts for later sessions. "
                "Do not edit repository files in this turn; no repository changes are required now. "
                "These contracts apply to relevant implementation work in Session 2 or later."
            ),
            block,
        ]
    )


def build_turn_message(
    session_index: int,
    session_count: int,
    prompt: str,
) -> str:
    """Wrap a session prompt with the memory-eval policy instructions."""
    if session_index == 1:
        intro = (
            "You are working in the repository at the current working directory. "
            "This is session 1 of a multi-session development task. Complete only "
            "the requirements for this session."
        )
    else:
        intro = (
            f"You are working in the repository at the current working directory. "
            f"This is session {session_index} of a {session_count}-session development task. "
            "The previous session has ended and conversation context is unavailable. "
            "Use the repository state to continue the task. "
            "Do not ask for previous conversation context. Complete only the requirements "
            "for this session."
        )
    parts = [intro, prompt.strip()]
    return "\n\n".join(part for part in parts if part)



def resolve_project_source(data: Dict[str, Any], generated_dir: Path, case_id: str) -> Path:
    """Resolve the generated project directory for a scenario."""
    raw_project_source = data.get("project_directory")
    candidates = []
    if raw_project_source:
        raw_path = Path(raw_project_source)
        candidates.append(raw_path if raw_path.is_absolute() else Path.cwd() / raw_path)
        candidates.append(raw_path if raw_path.is_absolute() else generated_dir.parent.parent / raw_path)
    candidates.append(generated_dir / case_id)

    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    raise FileNotFoundError(f"Project source not found for {case_id}: {candidates}")


def _stats_key(value: Any) -> str:
    text = str(value or "").strip()
    return text if text else "unknown"


def _sorted_counter(counter: Counter) -> Dict[str, int]:
    return {key: int(counter[key]) for key in sorted(counter)}


def _contract_id(contract: Dict[str, Any], index: int) -> str:
    return _stats_key(contract.get("id") or f"contract_{index}")


def _contract_category(contract: Dict[str, Any]) -> str:
    return _stats_key(contract.get("category") or contract.get("type") or "uncategorized")


def _append_unique(items: List[str], value: Any, limit: int = 12) -> None:
    text = str(value or "").strip()
    if not text or len(items) >= limit:
        return
    if text.lower() not in {item.lower() for item in items}:
        items.append(text)


def _memory_fact_prompt_anchors(original: Dict[str, Any], session_prompts: List[str]) -> Dict[str, List[str]]:
    anchors: Dict[str, List[str]] = {
        "prompt_paths": [],
        "prompt_identifiers": [],
        "prompt_routes": [],
        "prompt_config_keys": [],
    }
    for _, text in _source_texts(original, session_prompts):
        for path in re.findall(r"\b(?:src|lib|app|config|configs|tests|test|include|docs)/[A-Za-z0-9_./-]+\b", text):
            _append_unique(anchors["prompt_paths"], path)
        for route in re.findall(r"(?<![A-Za-z0-9_])/[A-Za-z0-9][A-Za-z0-9_./{}:-]*", text):
            if "." not in route.rstrip("/"):
                _append_unique(anchors["prompt_routes"], route)
        for token in re.findall(r"\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b|\b[A-Z][A-Z0-9]{3,}\b|\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b", text):
            bucket = "prompt_config_keys" if re.search(r"config|key|token|timeout|limit|cache|level|enabled|window|requests|url|path", token, flags=re.IGNORECASE) else "prompt_identifiers"
            _append_unique(anchors[bucket], token)
    return anchors


def _memory_fact_project_anchors(project_source: Path) -> Dict[str, List[str]]:
    anchors: Dict[str, List[str]] = {
        "project_headers": [],
        "project_test_files": _test_like_files(project_source)[:6],
        "project_docs": [],
        "project_config_files": [],
    }
    doc_names = {"readme", "api", "docs", "design", "architecture", "spec"}
    config_suffixes = {".conf", ".cfg", ".ini", ".json", ".yaml", ".yml", ".toml"}
    for path in sorted(project_source.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(project_source).as_posix()
        lower = rel.lower()
        if path.suffix == ".h":
            _append_unique(anchors["project_headers"], rel, limit=8)
        if path.suffix.lower() in config_suffixes or "/config" in lower or lower.startswith("config"):
            _append_unique(anchors["project_config_files"], rel, limit=8)
        if path.suffix.lower() in {".md", ".txt", ".rst"} and (set(lower.replace("/", "_").split("_")) & doc_names or lower.startswith("docs/")):
            _append_unique(anchors["project_docs"], rel, limit=8)
    return anchors


def _memory_fact_anchor_context(original: Dict[str, Any], session_prompts: List[str], project_source: Path) -> Dict[str, List[str]]:
    context = _memory_fact_prompt_anchors(original, session_prompts)
    context.update(_memory_fact_project_anchors(project_source))
    return context


def _memory_fact_anchor_keywords(anchor_sources: List[Any], anchor_context: Dict[str, List[str]], per_source_limit: int = 2, total_limit: int = 4) -> List[str]:
    keywords: List[str] = []
    for source in anchor_sources:
        values = anchor_context.get(str(source)) or []
        for value in values[:per_source_limit]:
            _append_unique(keywords, value, limit=total_limit)
    return keywords


def _contract_expected_memory_fact(
    contract: Dict[str, Any],
    index: int,
    anchor_context: Optional[Dict[str, List[str]]] = None,
) -> Dict[str, Any]:
    explicit = contract.get("expected_memory_fact")
    if isinstance(explicit, dict):
        fact = {"id": _contract_id(contract, index), **explicit}
        anchor_sources = fact.pop("anchor_sources", None) or contract.get("anchor_sources")
        if isinstance(anchor_sources, list) and anchor_context:
            required_keywords = _filter_memory_fact_keywords(fact.get("required_keywords") or [])
            for keyword in _memory_fact_anchor_keywords(anchor_sources, anchor_context):
                if keyword.lower() not in {item.lower() for item in required_keywords}:
                    required_keywords.append(keyword)
            fact["required_keywords"] = required_keywords
        else:
            fact["required_keywords"] = _filter_memory_fact_keywords(fact.get("required_keywords") or [])
        return fact

    keywords = contract.get("memory_keywords")
    if not isinstance(keywords, list):
        description = str(contract.get("description") or "")
        contract_id = _contract_id(contract, index)
        tokens = re.findall(r"[A-Za-z][A-Za-z0-9_]{2,}", f"{contract_id} {description}")
        stop = {"the", "and", "for", "any", "new", "use", "with", "fields", "this", "that", "later", "session", "sessions", "project", "specific", "memory", "keep", "applying", "convention", "conventions"}
        keywords = []
        for token in tokens:
            normalized = token.replace("_", " ").lower()
            for part in normalized.split():
                if part not in stop and part not in keywords:
                    keywords.append(part)
        keywords = keywords[:6]
    return {
        "id": _contract_id(contract, index),
        "category": _contract_category(contract),
        "description": str(contract.get("description") or ""),
        "required_keywords": _filter_memory_fact_keywords(keywords),
    }


def _contract_compliance_anchor_checks(
    contract: Dict[str, Any],
    index: int,
    anchor_context: Dict[str, List[str]],
) -> List[Dict[str, Any]]:
    """Derive minimal later-workspace compliance checks from contract-specific anchors."""
    explicit_fact = contract.get("expected_memory_fact") if isinstance(contract.get("expected_memory_fact"), dict) else {}
    anchor_sources = contract.get("compliance_anchor_sources") or explicit_fact.get("anchor_sources") or contract.get("anchor_sources")
    if not isinstance(anchor_sources, list):
        return []
    contract_id = _contract_id(contract, index)
    checks: List[Dict[str, Any]] = []
    for anchor in _memory_fact_anchor_keywords(anchor_sources, anchor_context, per_source_limit=1, total_limit=3):
        slug = re.sub(r"[^A-Za-z0-9_]+", "_", anchor).strip("_").lower()[:48] or "anchor"
        is_path = bool(re.match(r"^(?:src|lib|app|config|configs|tests|test|include|docs)/", anchor))
        is_file_path = is_path and bool(Path(anchor).suffix)
        check: Dict[str, Any] = {
            "id": f"{contract_id}_follow_{slug}",
            "source": "auto_contract_anchor",
            "strength": "contract_behavior_anchor",
            "rationale": "Later-session final workspace should preserve or reuse this contract-specific anchor; memory backend contents are checked separately by memory_content_quality.",
        }
        if is_file_path:
            check.update({"type": "file_exists", "path_glob": anchor, "signal_kind": "path"})
        else:
            check.update({"type": "require_regex", "path_glob": "**/*", "pattern": re.escape(anchor), "signal_kind": "identifier_or_route"})
        checks.append(check)
    return checks


def _contract_with_compliance_checks(
    contract: Dict[str, Any],
    index: int,
    anchor_context: Dict[str, List[str]],
) -> Dict[str, Any]:
    """Return the scoring-reference contract with hidden later-workspace checks attached."""
    normalized = dict(contract)
    generated = _contract_compliance_anchor_checks(contract, index, anchor_context)
    existing = contract.get("checks")
    if isinstance(existing, list):
        normalized["checks"] = [dict(check) if isinstance(check, dict) else check for check in existing] + generated
    elif existing is None and generated:
        normalized["checks"] = generated
    return normalized


def _contract_workspace_check_count(contract: Dict[str, Any]) -> int:
    checks = contract.get("checks")
    if not isinstance(checks, list):
        return 0
    return sum(1 for check in checks if isinstance(check, dict))

def _test_like_file_count(project_source: Path) -> int:
    count = 0
    for path in project_source.rglob("*"):
        if path.is_dir() and path.name.lower() in TEST_DIR_NAMES:
            count += 1
            continue
        if not path.is_file():
            continue
        name = path.name
        lower = name.lower()
        if lower in TEST_FILE_NAMES or "test" in lower or any(marker in lower for marker in TEST_FILE_MARKERS):
            count += 1
    return count


def _relative_working_dir(project_source: Path, directory: Path) -> str:
    try:
        return directory.resolve().relative_to(project_source.resolve()).as_posix() or "."
    except ValueError:
        return "."


def _makefile_has_test_target(path: Path) -> bool:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return bool(re.search(r"(?m)^test\s*:", text))


def _test_like_files(project_source: Path) -> List[str]:
    files = []
    for path in project_source.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(project_source).as_posix()
        lower = path.name.lower()
        parent_names = {part.lower() for part in path.parts}
        if (
            lower in TEST_FILE_NAMES
            or "test" in lower
            or any(marker in lower for marker in TEST_FILE_MARKERS)
            or parent_names & TEST_DIR_NAMES
        ):
            files.append(rel)
    return sorted(files)


def _strip_markdown_fence(text: str) -> str:
    stripped = text.lstrip()
    if not stripped.startswith("```"):
        return text
    lines = text.splitlines()
    if not lines or not lines[0].lstrip().startswith("```"):
        return text
    body = lines[1:]
    for index in range(len(body) - 1, -1, -1):
        if body[index].strip() == "```":
            body = body[:index]
            break
    return "\n".join(body).strip() + "\n"


def _cmake_file_has_testing(path: Path) -> bool:
    try:
        text = _strip_markdown_fence(path.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return False
    return bool(re.search(r"\b(enable_testing|add_test|include\s*\(\s*CTest\s*\))", text, flags=re.IGNORECASE))


def _script_mentions_test_runner(path: Path) -> bool:
    name = path.name.lower()
    if "test" in name and path.suffix in {".sh", ""}:
        return True
    try:
        text = path.read_text(encoding="utf-8", errors="replace")[:8192]
    except OSError:
        return False
    return "ctest" in text.lower() or "run_tests" in text.lower()


def _shell_command(value: str) -> List[str]:
    return [part for part in shlex.split(value) if part]


def _configured_overlay_test_plan(
    project_source: Path,
    language: Any,
    test_like_count: int,
    explicit: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    command = explicit.get("command")
    if isinstance(command, str):
        command = _shell_command(command)
    if not isinstance(command, list) or not command:
        return None
    integrity = explicit.get("integrity") if isinstance(explicit.get("integrity"), dict) else None
    if integrity is None:
        integrity = {"status": "basic", "original_test_files": _test_like_files(project_source)[:20]}
    plan = _base_test_plan(
        status="configured",
        command=[str(item) for item in command],
        working_dir=str(explicit.get("working_dir") or "."),
        source=str(explicit.get("source") or "overlay"),
        timeout_sec=int(explicit.get("timeout_sec") or 300),
        reason=None,
        test_like_count=test_like_count,
        language=language,
        integrity=integrity,
    )
    if explicit.get("docker_image"):
        plan["docker_image"] = str(explicit.get("docker_image"))
    if explicit.get("executor"):
        plan["executor"] = str(explicit.get("executor"))
    return plan


def _case_test_plan_overrides(overlay: Dict[str, Any], case_id: str, scenario_id: str) -> Optional[Dict[str, Any]]:
    for key in ("case_test_plans", "test_plans"):
        value = overlay.get(key)
        if not isinstance(value, dict):
            continue
        for lookup in (str(case_id or "").strip().lower(), str(scenario_id or "").strip().lower()):
            plan = value.get(lookup)
            if isinstance(plan, dict):
                return plan
    return None


def _docker_image_for_language(language: Any) -> str:
    language_key = str(language or "").strip().lower()
    mapping = {
        "c": "locobench-memory-eval:c",
        "cpp": "locobench-memory-eval:cpp",
        "c++": "locobench-memory-eval:cpp",
        "python": "locobench-memory-eval:python",
        "javascript": "locobench-memory-eval:javascript",
        "typescript": "locobench-memory-eval:javascript",
        "go": "locobench-memory-eval:go",
        "java": "locobench-memory-eval:java",
        "rust": "locobench-memory-eval:rust",
        "csharp": "locobench-memory-eval:csharp",
        "c#": "locobench-memory-eval:csharp",
        "php": "locobench-memory-eval:php",
    }
    return mapping.get(language_key, "locobench-memory-eval:base")


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


def _makefile_test_integrity(project_source: Path, makefile: Path) -> Dict[str, Any]:
    try:
        text = makefile.read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = ""
    target = _extract_makefile_test_target(text)
    rel_makefile = makefile.relative_to(project_source).as_posix()
    test_files = [path for path in _test_like_files(project_source) if path.startswith(makefile.parent.relative_to(project_source).as_posix().rstrip(".") + "/") or "/" not in path]
    if not test_files:
        test_files = _test_like_files(project_source)
    required_patterns: List[str] = []
    for match in re.findall(r"(?:\$\([A-Za-z0-9_]+\)|tests?/[^\s$()]+|[A-Za-z0-9_]*test[A-Za-z0-9_./-]*)", target):
        token = match.strip()
        if token and token not in required_patterns:
            required_patterns.append(token)
    digest = hashlib.sha256(target.encode("utf-8")).hexdigest() if target else ""
    return {
        "status": "checkable" if target else "not_checked",
        "original_command": ["make", "test"],
        "original_test_files": test_files[:20],
        "required_patterns": required_patterns[:12],
        "makefile_path": rel_makefile,
        "makefile_test_target_fingerprint": f"sha256:{digest}" if digest else None,
    }


def _base_test_plan(
    *,
    status: str,
    command: List[str],
    working_dir: str,
    source: str,
    timeout_sec: int,
    reason: Optional[str],
    test_like_count: int,
    language: Any,
    integrity: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return {
        "status": status,
        "command": [str(item) for item in command],
        "working_dir": working_dir,
        "source": source,
        "timeout_sec": timeout_sec,
        "reason": reason,
        "test_like_file_count": test_like_count,
        "executor": "host",
        "docker_image": _docker_image_for_language(language),
        "environment": {"recommended_executor": "docker", "network": "none"},
        "integrity": integrity or {"status": "not_checked", "reason": "no test integrity metadata available"},
    }


def _resolve_test_plan(project_source: Path, language: Any, overlay: Dict[str, Any], case_id: str = "", scenario_id: str = "") -> Dict[str, Any]:
    """Resolve a conservative final-workspace test command for one prepared case."""
    test_like_count = _test_like_file_count(project_source)
    case_override = _case_test_plan_overrides(overlay, case_id, scenario_id)
    if case_override:
        plan = _configured_overlay_test_plan(project_source, language, test_like_count, case_override)
        if plan is not None:
            return plan

    explicit = overlay.get("test_plan") or overlay.get("test_command")
    if isinstance(explicit, dict):
        plan = _configured_overlay_test_plan(project_source, language, test_like_count, explicit)
        if plan is not None:
            return plan
    elif isinstance(explicit, str) and explicit.strip():
        return _base_test_plan(
            status="configured",
            command=_shell_command(explicit),
            working_dir=".",
            source="overlay",
            timeout_sec=300,
            reason=None,
            test_like_count=test_like_count,
            language=language,
        )

    makefiles = sorted(project_source.rglob("Makefile"))
    for makefile in makefiles:
        if _makefile_has_test_target(makefile):
            return _base_test_plan(
                status="configured",
                command=["make", "test"],
                working_dir=_relative_working_dir(project_source, makefile.parent),
                source="makefile_test_target",
                timeout_sec=300,
                reason=None,
                test_like_count=test_like_count,
                language=language,
                integrity=_makefile_test_integrity(project_source, makefile),
            )

    language_key = str(language or "").strip().lower()
    if language_key in {"csharp", "c#"}:
        test_projects = sorted(
            path
            for path in project_source.rglob("*.csproj")
            if "test" in path.name.lower() or any("test" in part.lower() for part in path.parts)
        )
        if test_projects:
            path = test_projects[0]
            return _base_test_plan(
                status="configured",
                command=["dotnet", "test", path.name, "--no-restore"],
                working_dir=_relative_working_dir(project_source, path.parent),
                source="dotnet_test_project",
                timeout_sec=600,
                reason=None,
                test_like_count=test_like_count,
                language=language,
                integrity={"status": "basic", "original_test_files": _test_like_files(project_source)[:20]},
            )

    if language_key == "php":
        composer_files = sorted(project_source.rglob("composer.json"))
        for composer_file in composer_files:
            try:
                composer = json.loads(_strip_markdown_fence(composer_file.read_text(encoding="utf-8", errors="replace")))
            except (OSError, json.JSONDecodeError):
                continue
            scripts = composer.get("scripts") if isinstance(composer, dict) else None
            if isinstance(scripts, dict) and scripts.get("test"):
                return _base_test_plan(
                    status="configured",
                    command=["composer", "run", "test", "--no-interaction"],
                    working_dir=_relative_working_dir(project_source, composer_file.parent),
                    source="composer_test_script",
                    timeout_sec=600,
                    reason=None,
                    test_like_count=test_like_count,
                    language=language,
                    integrity={"status": "basic", "original_test_files": _test_like_files(project_source)[:20]},
                )
        phpunit_files = sorted([*project_source.rglob("phpunit.xml"), *project_source.rglob("phpunit.xml.dist")])
        if phpunit_files:
            path = phpunit_files[0]
            return _base_test_plan(
                status="configured",
                command=["phpunit", "-c", path.name],
                working_dir=_relative_working_dir(project_source, path.parent),
                source="phpunit_config",
                timeout_sec=600,
                reason=None,
                test_like_count=test_like_count,
                language=language,
                integrity={"status": "basic", "original_test_files": _test_like_files(project_source)[:20]},
            )

    package_files = sorted(project_source.rglob("package.json"))
    for package_file in package_files:
        try:
            package = json.loads(package_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        scripts = package.get("scripts") if isinstance(package, dict) else None
        if isinstance(scripts, dict) and str(scripts.get("test") or "").strip():
            return _base_test_plan(
                status="configured",
                command=["npm", "test"],
                working_dir=_relative_working_dir(project_source, package_file.parent),
                source="package_json_test_script",
                timeout_sec=300,
                reason=None,
                test_like_count=test_like_count,
                language=language,
                integrity={"status": "basic", "original_test_files": _test_like_files(project_source)[:20]},
            )

    for script in sorted(project_source.rglob("*.sh")):
        if _script_mentions_test_runner(script):
            return _base_test_plan(
                status="configured",
                command=["bash", script.name],
                working_dir=_relative_working_dir(project_source, script.parent),
                source="test_runner_script",
                timeout_sec=600,
                reason=None,
                test_like_count=test_like_count,
                language=language,
                integrity={"status": "basic", "original_test_files": _test_like_files(project_source)[:20]},
            )

    for cmake_file in sorted(project_source.rglob("CMakeLists.txt")):
        if _cmake_file_has_testing(cmake_file):
            return _base_test_plan(
                status="configured",
                command=["sh", "-lc", "cmake -S . -B build -DBUILD_TESTING=ON -DENABLE_TESTS=ON -DSC_ENABLE_TESTS=ON && cmake --build build --parallel 2 && ctest --test-dir build --output-on-failure"],
                working_dir=_relative_working_dir(project_source, cmake_file.parent),
                source="cmake_ctest",
                timeout_sec=600,
                reason=None,
                test_like_count=test_like_count,
                language=language,
                integrity={"status": "basic", "original_test_files": _test_like_files(project_source)[:20]},
            )

    for marker, command, source in (
        ("go.mod", ["go", "test", "./..."], "go_mod"),
        ("Cargo.toml", ["cargo", "test"], "cargo_toml"),
        ("pom.xml", ["mvn", "test"], "maven_pom"),
    ):
        for path in sorted(project_source.rglob(marker)):
            return _base_test_plan(
                status="configured",
                command=command,
                working_dir=_relative_working_dir(project_source, path.parent),
                source=source,
                timeout_sec=300,
                reason=None,
                test_like_count=test_like_count,
                language=language,
                integrity={"status": "basic", "original_test_files": _test_like_files(project_source)[:20]},
            )

    if language_key == "python" and test_like_count:
        return _base_test_plan(
            status="configured",
            command=["python3", "-m", "pytest"],
            working_dir=".",
            source="python_pytest_fallback",
            timeout_sec=300,
            reason=None,
            test_like_count=test_like_count,
            language=language,
            integrity={"status": "basic", "original_test_files": _test_like_files(project_source)[:20]},
        )

    if test_like_count:
        return _base_test_plan(
            status="unresolved",
            command=[],
            working_dir=".",
            source="test_like_files_only",
            timeout_sec=300,
            reason="test-like files exist but no reliable test command was resolved",
            test_like_count=test_like_count,
            language=language,
        )
    return _base_test_plan(
        status="no_tests",
        command=[],
        working_dir=".",
        source="no_test_like_files",
        timeout_sec=300,
        reason="no test-like files found",
        test_like_count=0,
        language=language,
    )


GENERIC_REQUIREMENT_TERMS = {
    "agent", "build", "context", "correct", "correctly", "create", "data", "ensure", "feature", "file", "files",
    "function", "implement", "implementation", "module", "project", "session", "support", "system", "test", "tests",
    "update", "user", "users", "validation", "work", "working",
}

DOMAIN_FEATURE_PATTERNS = (
    "rate_limit", "pagination", "retry_after", "idempotency_key", "graphql_schema", "error_envelope",
    "circuit_breaker", "health_check", "auth_token", "request_timeout", "cache_control", "webhook_signature",
)


def _requirement_check_id(value: Dict[str, Any], fallback: str) -> str:
    return str(value.get("id") or fallback).strip() or fallback


def _normalise_requirement_check(check: Dict[str, Any], default_source: str, default_strength: str = "explicit") -> Dict[str, Any]:
    normalized = dict(check)
    normalized.setdefault("source", default_source)
    normalized.setdefault("strength", default_strength)
    normalized.setdefault("signal_kind", "overlay" if default_source == "overlay" else "unknown")
    normalized.setdefault("rationale", "evaluator-owned deterministic requirement check")
    return normalized


def _scoped_requirement_checks(
    overlay: Dict[str, Any],
    scenario_id: str,
    case_id: str,
    language: Any,
    category: Any,
) -> List[Dict[str, Any]]:
    selected: List[Dict[str, Any]] = []
    positions: Dict[str, int] = {}

    def add_many(items: List[Dict[str, Any]]) -> None:
        for item in items:
            normalized = _normalise_requirement_check(item, "overlay", "explicit")
            check_id = _requirement_check_id(normalized, f"requirement_{len(selected) + 1}")
            normalized["id"] = check_id
            if check_id in positions:
                selected[positions[check_id]] = normalized
            else:
                positions[check_id] = len(selected)
                selected.append(normalized)

    add_many(overlay.get("requirement_checks") or [])
    language_key = str(language or "").strip().lower()
    category_key = str(category or "").strip().lower()
    add_many((overlay.get("language_requirement_checks") or {}).get(language_key) or [])
    add_many((overlay.get("category_requirement_checks") or {}).get(category_key) or [])
    case_map = overlay.get("case_requirement_checks") or {}
    add_many(case_map.get(str(case_id or "").strip().lower()) or [])
    add_many(case_map.get(str(scenario_id or "").strip().lower()) or [])
    return selected


def _source_texts(original: Dict[str, Any], session_prompts: List[str]) -> List[Tuple[str, str]]:
    values = [
        ("evaluation_criteria", original.get("evaluation_criteria")),
        ("expected_approach", original.get("expected_approach")),
        ("ground_truth", original.get("ground_truth")),
        ("task_prompt", "\n".join(session_prompts)),
    ]
    texts = []
    for name, value in values:
        if value is None:
            continue
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        if text.strip():
            texts.append((name, text))
    return texts


def _generic_requirement_candidates(text: str) -> List[str]:
    terms = []
    for quoted, word in re.findall(r"`([^`]{3,80})`|\b([A-Za-z_][A-Za-z0-9_]{3,60})\b", text):
        term = (quoted or word).strip()
        normal = term.lower().replace("-", "_")
        if normal in GENERIC_REQUIREMENT_TERMS and normal not in terms:
            terms.append(normal)
    return terms[:20]


def _strong_requirement_signals(original: Dict[str, Any], session_prompts: List[str]) -> Tuple[List[Dict[str, Any]], List[Dict[str, str]]]:
    signals: List[Dict[str, Any]] = []
    rejected: List[Dict[str, str]] = []
    seen = set()

    def add(kind: str, value: str, origin_field: str, pattern: Optional[str] = None, path_glob: str = "**/*") -> None:
        value = value.strip()
        normal = value.lower().replace("-", "_")
        if not value or normal in GENERIC_REQUIREMENT_TERMS:
            rejected.append({"term": normal or value, "reason": "generic_term", "origin_field": origin_field})
            return
        key = (kind, normal)
        if key in seen:
            return
        seen.add(key)
        signals.append({
            "signal_kind": kind,
            "value": value,
            "pattern": pattern or re.escape(value).replace("\\_", "[_-]"),
            "path_glob": path_glob,
            "origin_field": origin_field,
        })

    for origin_field, text in _source_texts(original, session_prompts):
        for term in _generic_requirement_candidates(text):
            rejected.append({"term": term, "reason": "generic_term", "origin_field": origin_field})
        for path in re.findall(r"\b(?:src|lib|app|config|configs|tests|test|include|docs)/[A-Za-z0-9_./-]+\.[A-Za-z0-9_]+\b", text):
            add("path", path, origin_field, path_glob=path)
        for status in re.findall(r"\b(?:HTTP\s*)?([45][0-9]{2})\b", text, flags=re.IGNORECASE):
            add("status_code", status, origin_field, pattern=rf"\b{re.escape(status)}\b|HTTP[_\s-]*{re.escape(status)}")
        if re.search(r"too many requests", text, flags=re.IGNORECASE):
            add("status_code", "Too Many Requests", origin_field, pattern=r"Too\s+Many\s+Requests|429|MHD_HTTP_TOO_MANY_REQUESTS")
        for error_code in re.findall(r"\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,}\b", text):
            add("error_code", error_code, origin_field)
        for feature in DOMAIN_FEATURE_PATTERNS:
            if re.search(re.escape(feature).replace("_", r"[_\s-]?"), text, flags=re.IGNORECASE):
                add("domain_feature", feature, origin_field, pattern=re.escape(feature).replace("\\_", "[_\\s-]?"))
        for ident in re.findall(r"`([A-Za-z_][A-Za-z0-9_]{3,60})`|\b([A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+|[a-z][a-z0-9]+(?:_[a-z0-9]+)+)\b", text):
            token = (ident[0] or ident[1]).strip()
            normal = token.lower()
            if normal in GENERIC_REQUIREMENT_TERMS:
                rejected.append({"term": normal, "reason": "generic_term", "origin_field": origin_field})
                continue
            if any(part in normal for part in ("limit", "rate", "retry", "timeout", "config", "error", "graphql", "schema", "auth", "cache", "token", "route")):
                kind = "config_key" if "config" in normal or normal.startswith("rate_limit") else "identifier"
                add(kind, token, origin_field)
    return signals, rejected


def _auto_requirement_checks(original: Dict[str, Any], session_prompts: List[str], max_checks: int = 5) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    signals, rejected = _strong_requirement_signals(original, session_prompts)
    checks = []
    for signal in signals[:max_checks]:
        value_slug = re.sub(r"[^A-Za-z0-9_]+", "_", signal["value"]).strip("_").lower()[:48]
        check_type = "file_exists" if signal["signal_kind"] == "path" else "require_regex"
        check = {
            "id": f"require_{value_slug or signal['signal_kind']}",
            "type": check_type,
            "path_glob": signal["path_glob"] if check_type == "file_exists" else "**/*",
            "source": "auto_strong_signal",
            "strength": "strong",
            "signal_kind": signal["signal_kind"],
            "origin_field": signal["origin_field"],
            "rationale": f"strong technical {signal['signal_kind']} signal extracted from evaluator-owned task metadata",
        }
        if check_type != "file_exists":
            check["pattern"] = signal["pattern"]
        checks.append(check)
    if checks:
        return checks, _requirement_plan("configured", "auto_strong_signal", None, checks, rejected)
    return [], _requirement_plan("not_configured", "auto_strong_signal", "no_strong_requirement_signals", [], rejected)


def _requirement_plan(status: str, source: str, reason: Optional[str], checks: List[Dict[str, Any]], rejected_terms: Optional[List[Dict[str, str]]] = None) -> Dict[str, Any]:
    source_distribution = Counter(str(check.get("source") or source) for check in checks)
    strength_distribution = Counter(str(check.get("strength") or "unknown") for check in checks)
    signal_kind_distribution = Counter(str(check.get("signal_kind") or "unknown") for check in checks)
    rejection_distribution = Counter(str(item.get("reason") or "unknown") for item in (rejected_terms or []))
    return {
        "status": status,
        "source": source,
        "reason": reason,
        "check_count": len(checks),
        "source_distribution": _sorted_counter(source_distribution),
        "strength_distribution": _sorted_counter(strength_distribution),
        "signal_kind_distribution": _sorted_counter(signal_kind_distribution),
        "rejection_reason_distribution": _sorted_counter(rejection_distribution),
        "rejected_terms": (rejected_terms or [])[:20],
    }


def _requirement_checks_for_case(
    original: Dict[str, Any],
    session_prompts: List[str],
    overlay: Dict[str, Any],
    scenario_id: str,
    case_id: str,
    language: Any,
    category: Any,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    explicit = _scoped_requirement_checks(overlay, scenario_id, case_id, language, category)
    if explicit:
        return explicit, _requirement_plan("configured", "overlay", None, explicit)
    return [], _requirement_plan(
        "not_configured",
        "evaluator_overlay",
        "explicit_evaluator_checks_required",
        [],
    )


def prepare_dataset(
    scenarios_dir: Path,
    generated_dir: Path,
    output_dir: Path,
    category: str = "extended_development_projects",
    limit: Optional[int] = None,
    contract_overlay: Optional[Path] = None,
) -> Dict[str, Any]:
    """Prepare a memory eval dataset from LoCoBench-Agent scenario JSON files."""
    scenarios_dir = scenarios_dir.resolve()
    generated_dir = generated_dir.resolve()
    output_dir = output_dir.resolve()
    if output_dir.exists() and any(output_dir.iterdir()):
        raise FileExistsError(
            f"Prepared output is immutable and already contains files: {output_dir}. "
            "Choose a new output directory."
        )
    overlay = _load_contract_overlay(contract_overlay.resolve() if contract_overlay is not None else None)
    scenario_files = sorted(scenarios_dir.glob("*multi_session_development*.json"))
    prepared_cases: List[PreparedCase] = []
    difficulty_distribution: Counter = Counter()
    task_type_distribution: Counter = Counter()
    programming_language_distribution: Counter = Counter()
    contracts_per_case_distribution: Counter = Counter()
    contract_id_distribution: Counter = Counter()
    contract_category_distribution: Counter = Counter()
    contract_memory_type_distribution: Counter = Counter()
    workspace_checkable_contracts_per_case_distribution: Counter = Counter()
    memory_fact_contracts_per_case_distribution: Counter = Counter()
    test_availability_distribution: Counter = Counter()
    test_plan_distribution: Counter = Counter()
    requirement_checks_per_case_distribution: Counter = Counter()
    requirement_check_status_distribution: Counter = Counter()
    requirement_check_source_distribution: Counter = Counter()
    requirement_check_strength_distribution: Counter = Counter()
    requirement_check_signal_kind_distribution: Counter = Counter()
    requirement_check_rejection_distribution: Counter = Counter()
    case_contracts: List[Dict[str, Any]] = []
    case_requirement_checks: List[Dict[str, Any]] = []

    for scenario_file in scenario_files:
        data = read_json(scenario_file)
        if not is_memory_eval_scenario(data, category):
            continue

        scenario_id = data.get("scenario_id") or data.get("id") or scenario_file.stem
        case_id = extract_case_id(scenario_id)

        original = data.get("original_scenario") or {}
        task_prompt = original.get("task_prompt") or data.get("description") or ""
        session_prompts = split_prompt_into_sessions(task_prompt)
        if not session_prompts:
            continue

        project_source = resolve_project_source(data, generated_dir, case_id)

        case_dir = output_dir / "cases" / scenario_id
        case_project_dir = case_dir / "project"
        copy_tree_clean(project_source, case_project_dir)
        prepared_project_source = Path("cases") / str(scenario_id) / "project"
        turns_dir = case_dir / "turns"
        prompts_dir = case_dir / "prompts"
        turns: List[PreparedTurn] = []
        prompts_for_review: List[Dict[str, Any]] = []

        project_spec = data.get("project_spec") or {}
        language = project_spec.get("language", "unknown")
        case_contracts_for_case = _contracts_for_case(
            overlay,
            scenario_id,
            case_id,
            language,
            original.get("task_category", "multi_session_development"),
        )

        for idx, session_prompt in enumerate(session_prompts, start=1):
            turn_message = build_turn_message(
                idx,
                len(session_prompts),
                session_prompt,
            )
            messages = [
                {
                    "type": "user",
                    "message": {"role": "user", "content": turn_message},
                    "parent_tool_use_id": None,
                }
            ]
            contract_followup = _contract_followup_message(case_contracts_for_case) if idx == 1 else ""
            review_text = turn_message
            if contract_followup:
                messages.append(
                    {
                        "type": "user",
                        "message": {"role": "user", "content": contract_followup},
                        "parent_tool_use_id": None,
                    }
                )
                review_text = f"{turn_message}\n\n--- follow-up turn ---\n\n{contract_followup}"
            turn_file = turns_dir / f"session_{idx}.jsonl"
            prompt_file = prompts_dir / f"session_{idx}.txt"
            write_jsonl(turn_file, messages)
            prompt_file.parent.mkdir(parents=True, exist_ok=True)
            prompt_file.write_text(review_text + "\n", encoding="utf-8")
            turns.append(PreparedTurn(session=idx, file=f"turns/session_{idx}.jsonl", turn_count=len(messages)))
            prompts_for_review.append({"session": idx, "file": f"prompts/session_{idx}.txt"})

        prepared = PreparedCase(
            scenario_id=scenario_id,
            case_id=case_id,
            category=data.get("category", category),
            original_task_category=original.get("task_category", "multi_session_development"),
            project_source=prepared_project_source.as_posix(),
            project_name=data.get("project_name") or project_spec.get("name") or case_id,
            language=language,
            complexity=project_spec.get("complexity", data.get("difficulty", "unknown")),
            session_count=len(turns),
            turns=turns,
            prompts_for_review=prompts_for_review,
            hashes={
                "scenario_json_sha256": sha256_file(scenario_file),
                "project_tree_sha256": sha256_tree(project_source),
                "prepared_case_sha256": "",
            },
        )

        test_plan = _resolve_test_plan(project_source, prepared.language, overlay, case_id=case_id, scenario_id=scenario_id)
        requirement_checks, requirement_check_plan = _requirement_checks_for_case(
            original,
            session_prompts,
            overlay,
            scenario_id,
            case_id,
            prepared.language,
            prepared.original_task_category,
        )
        memory_fact_anchor_context = _memory_fact_anchor_context(original, session_prompts, project_source)
        scoring_contracts_for_case = [
            _contract_with_compliance_checks(contract, index, memory_fact_anchor_context)
            for index, contract in enumerate(case_contracts_for_case, start=1)
            if isinstance(contract, dict)
        ]
        expected_memory_facts = [
            _contract_expected_memory_fact(contract, index, memory_fact_anchor_context)
            for index, contract in enumerate(case_contracts_for_case, start=1)
            if isinstance(contract, dict)
        ]
        scoring_reference = {
            "scenario_id": scenario_id,
            "ground_truth": original.get("ground_truth"),
            "expected_approach": original.get("expected_approach"),
            "evaluation_criteria": original.get("evaluation_criteria"),
            "memory_contracts": scoring_contracts_for_case,
            "expected_memory_facts": expected_memory_facts,
            "test_plan": test_plan,
            "requirement_checks": requirement_checks,
            "requirement_check_plan": requirement_check_plan,
        }
        metadata = {
            "scenario_id": scenario_id,
            "case_id": case_id,
            "title": data.get("title") or original.get("title"),
            "description": data.get("description") or original.get("description"),
            "difficulty": data.get("difficulty") or original.get("difficulty"),
            "project_spec": project_spec,
        }

        write_json(case_dir / "metadata.json", metadata)
        write_json(case_dir / "scoring_reference.json", scoring_reference)
        prepared.hashes["prepared_case_sha256"] = sha256_prepared_case(case_dir)
        write_json(case_dir / "case.json", prepared.to_dict())
        prepared_cases.append(prepared)
        difficulty_distribution[_stats_key(metadata.get("difficulty"))] += 1
        task_type_distribution[_stats_key(prepared.original_task_category)] += 1
        programming_language_distribution[_stats_key(prepared.language)] += 1

        contract_ids = [_contract_id(contract, index) for index, contract in enumerate(case_contracts_for_case, start=1) if isinstance(contract, dict)]
        contract_categories = [_contract_category(contract) for contract in case_contracts_for_case if isinstance(contract, dict)]
        contract_memory_types = [str(contract.get("memory_type") or "project").strip().lower() or "project" for contract in case_contracts_for_case if isinstance(contract, dict)]
        workspace_checkable_contract_ids = [
            _contract_id(contract, index)
            for index, contract in enumerate(scoring_contracts_for_case, start=1)
            if isinstance(contract, dict) and _contract_workspace_check_count(contract)
        ]
        memory_fact_contract_ids = [
            str(fact.get("id") or f"fact_{index}")
            for index, fact in enumerate(expected_memory_facts, start=1)
            if isinstance(fact, dict)
            and (fact.get("required_keywords") or fact.get("required_regex") or fact.get("forbidden_keywords"))
        ]
        contracts_per_case_distribution[str(len(contract_ids))] += 1
        workspace_checkable_contracts_per_case_distribution[str(len(workspace_checkable_contract_ids))] += 1
        memory_fact_contracts_per_case_distribution[str(len(memory_fact_contract_ids))] += 1
        for contract_id in contract_ids:
            contract_id_distribution[contract_id] += 1
        for contract_category in contract_categories:
            contract_category_distribution[contract_category] += 1
        for memory_type in contract_memory_types:
            contract_memory_type_distribution[memory_type] += 1
        case_contracts.append(
            {
                "scenario_id": scenario_id,
                "case_id": case_id,
                "contract_count": len(contract_ids),
                "memory_fact_contract_count": len(memory_fact_contract_ids),
                "workspace_checkable_contract_count": len(workspace_checkable_contract_ids),
                "contract_ids": contract_ids,
                "memory_fact_contract_ids": memory_fact_contract_ids,
                "workspace_checkable_contract_ids": workspace_checkable_contract_ids,
                "contract_categories": sorted(set(contract_categories)),
                "memory_types": sorted(set(contract_memory_types)),
            }
        )
        test_like_count = int(test_plan.get("test_like_file_count") or _test_like_file_count(project_source))
        test_availability_distribution["with_test_like_files" if test_like_count else "without_test_like_files"] += 1
        test_plan_distribution[_stats_key(test_plan.get("status"))] += 1
        requirement_checks_per_case_distribution[str(len(requirement_checks))] += 1
        requirement_check_status_distribution[_stats_key(requirement_check_plan.get("status"))] += 1
        for key, count in (requirement_check_plan.get("source_distribution") or {}).items():
            requirement_check_source_distribution[_stats_key(key)] += int(count or 0)
        for key, count in (requirement_check_plan.get("strength_distribution") or {}).items():
            requirement_check_strength_distribution[_stats_key(key)] += int(count or 0)
        for key, count in (requirement_check_plan.get("signal_kind_distribution") or {}).items():
            requirement_check_signal_kind_distribution[_stats_key(key)] += int(count or 0)
        for key, count in (requirement_check_plan.get("rejection_reason_distribution") or {}).items():
            requirement_check_rejection_distribution[_stats_key(key)] += int(count or 0)
        case_requirement_checks.append(
            {
                "scenario_id": scenario_id,
                "case_id": case_id,
                "check_count": len(requirement_checks),
                "status": requirement_check_plan.get("status"),
                "source": requirement_check_plan.get("source"),
                "reason": requirement_check_plan.get("reason"),
                "check_ids": [str(check.get("id") or f"requirement_{idx}") for idx, check in enumerate(requirement_checks, start=1)],
                "signal_kinds": sorted({str(check.get("signal_kind") or "unknown") for check in requirement_checks}),
                "strengths": sorted({str(check.get("strength") or "unknown") for check in requirement_checks}),
            }
        )

        if limit and len(prepared_cases) >= limit:
            break

    manifest_rows = [case.to_dict() for case in prepared_cases]
    write_jsonl(output_dir / "manifest.jsonl", manifest_rows)
    prepared_dataset_sha256 = sha256_prepared_dataset(output_dir)
    summary = {
        "schema_version": "memory_eval_prepared_v2_immutable",
        "prepared_dataset_sha256": prepared_dataset_sha256,
        "case_count": len(prepared_cases),
        "category": category,
        "cases": [case.scenario_id for case in prepared_cases],
        "contract_overlay": str(contract_overlay.resolve()) if contract_overlay is not None else None,
        "memory_contract_count": len(contract_id_distribution),
        "dataset_stats": {
            "difficulty_distribution": _sorted_counter(difficulty_distribution),
            "task_type_distribution": _sorted_counter(task_type_distribution),
            "programming_language_distribution": _sorted_counter(programming_language_distribution),
            "contract_stats": {
                "contracts_per_case_distribution": _sorted_counter(contracts_per_case_distribution),
                "contract_id_distribution": _sorted_counter(contract_id_distribution),
                "contract_category_distribution": _sorted_counter(contract_category_distribution),
                "contract_memory_type_distribution": _sorted_counter(contract_memory_type_distribution),
                "workspace_checkable_contracts_per_case_distribution": _sorted_counter(workspace_checkable_contracts_per_case_distribution),
                "memory_fact_contracts_per_case_distribution": _sorted_counter(memory_fact_contracts_per_case_distribution),
                "case_contracts": case_contracts,
            },
            "test_availability_stats": _sorted_counter(test_availability_distribution),
            "test_plan_stats": _sorted_counter(test_plan_distribution),
            "requirement_check_stats": {
                "checks_per_case_distribution": _sorted_counter(requirement_checks_per_case_distribution),
                "status_distribution": _sorted_counter(requirement_check_status_distribution),
                "configured_cases": int(requirement_check_status_distribution.get("configured", 0)),
                "not_configured_cases": int(sum(count for status, count in requirement_check_status_distribution.items() if status != "configured")),
                "source_distribution": _sorted_counter(requirement_check_source_distribution),
                "strength_distribution": _sorted_counter(requirement_check_strength_distribution),
                "signal_kind_distribution": _sorted_counter(requirement_check_signal_kind_distribution),
                "rejection_reason_distribution": _sorted_counter(requirement_check_rejection_distribution),
                "configured_by_overlay_cases": int(sum(1 for item in case_requirement_checks if item.get("status") == "configured" and item.get("source") == "overlay")),
                "configured_by_auto_cases": int(sum(1 for item in case_requirement_checks if item.get("status") == "configured" and item.get("source") == "auto_strong_signal")),
                "case_requirement_checks": case_requirement_checks,
            },
        },
    }
    write_json(output_dir / "summary.json", summary)
    return summary
