"""Prepare LoCoBench-Agent multi-session scenarios for memory evaluation."""

import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .io import read_json, sha256_file, sha256_tree, write_json, write_jsonl
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


def build_turn_message(session_index: int, session_count: int, prompt: str) -> str:
    """Wrap a session prompt with the memory-eval policy instructions."""
    if session_index == 1:
        intro = (
            "You are working in the repository at the current working directory. "
            "This is session 1 of a multi-session development task. Complete only "
            "the requirements for this session. At the end, save any useful "
            "project-specific memory for future sessions."
        )
    else:
        intro = (
            f"You are working in the repository at the current working directory. "
            f"This is session {session_index} of a {session_count}-session development task. "
            "The previous session has ended and conversation context is unavailable. "
            "Use the repository state and your persistent memory if available. "
            "Do not ask for previous conversation context. Complete only the requirements "
            "for this session. At the end, update memory with decisions and remaining work."
        )
    return f"{intro}\n\n{prompt.strip()}"


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


def prepare_dataset(
    scenarios_dir: Path,
    generated_dir: Path,
    output_dir: Path,
    category: str = "extended_development_projects",
    limit: Optional[int] = None,
) -> Dict[str, Any]:
    """Prepare a memory eval dataset from LoCoBench-Agent scenario JSON files."""
    scenarios_dir = scenarios_dir.resolve()
    generated_dir = generated_dir.resolve()
    output_dir = output_dir.resolve()
    scenario_files = sorted(scenarios_dir.glob("*multi_session_development*.json"))
    prepared_cases: List[PreparedCase] = []

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
        turns_dir = case_dir / "turns"
        prompts_dir = case_dir / "prompts"
        turns: List[PreparedTurn] = []
        prompts_for_review: List[Dict[str, Any]] = []

        for idx, session_prompt in enumerate(session_prompts, start=1):
            turn_message = build_turn_message(idx, len(session_prompts), session_prompt)
            turn_file = turns_dir / f"session_{idx}.jsonl"
            prompt_file = prompts_dir / f"session_{idx}.txt"
            write_jsonl(
                turn_file,
                [
                    {
                        "type": "user",
                        "message": {"role": "user", "content": turn_message},
                        "parent_tool_use_id": None,
                    }
                ],
            )
            prompt_file.parent.mkdir(parents=True, exist_ok=True)
            prompt_file.write_text(turn_message + "\n", encoding="utf-8")
            turns.append(PreparedTurn(session=idx, file=f"turns/session_{idx}.jsonl", turn_count=1))
            prompts_for_review.append({"session": idx, "file": f"prompts/session_{idx}.txt"})

        project_spec = data.get("project_spec") or {}
        prepared = PreparedCase(
            scenario_id=scenario_id,
            case_id=case_id,
            category=data.get("category", category),
            original_task_category=original.get("task_category", "multi_session_development"),
            project_source=str(project_source),
            project_name=data.get("project_name") or project_spec.get("name") or case_id,
            language=project_spec.get("language", "unknown"),
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

        scoring_reference = {
            "scenario_id": scenario_id,
            "ground_truth": original.get("ground_truth"),
            "expected_approach": original.get("expected_approach"),
            "evaluation_criteria": original.get("evaluation_criteria"),
        }
        metadata = {
            "scenario_id": scenario_id,
            "case_id": case_id,
            "title": data.get("title") or original.get("title"),
            "description": data.get("description") or original.get("description"),
            "difficulty": data.get("difficulty") or original.get("difficulty"),
            "project_spec": project_spec,
        }

        write_json(case_dir / "case.json", prepared.to_dict())
        prepared.hashes["prepared_case_sha256"] = sha256_tree(case_dir)
        write_json(case_dir / "case.json", prepared.to_dict())
        write_json(case_dir / "metadata.json", metadata)
        write_json(case_dir / "scoring_reference.json", scoring_reference)
        prepared_cases.append(prepared)

        if limit and len(prepared_cases) >= limit:
            break

    manifest_rows = [case.to_dict() for case in prepared_cases]
    write_jsonl(output_dir / "manifest.jsonl", manifest_rows)
    summary = {
        "case_count": len(prepared_cases),
        "category": category,
        "cases": [case.scenario_id for case in prepared_cases],
    }
    write_json(output_dir / "summary.json", summary)
    return summary
