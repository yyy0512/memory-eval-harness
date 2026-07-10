"""Schemas for the LoCoBench memory evaluation harness."""

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class PreparedTurn:
    """A prepared stream-json input file for one benchmark session."""

    session: int
    file: str
    turn_count: int

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class PreparedCase:
    """Metadata for one prepared memory-eval case."""

    scenario_id: str
    case_id: str
    category: str
    original_task_category: str
    project_source: str
    project_name: str
    language: str
    complexity: str
    session_count: int
    turns: List[PreparedTurn]
    prompts_for_review: List[Dict[str, Any]]
    hashes: Dict[str, str]

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["turns"] = [turn.to_dict() for turn in self.turns]
        return data


@dataclass
class TokenMetrics:
    """Token, cost, and duration metrics extracted from a CLI result event."""

    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    new_input_output_tokens: int = 0
    total_reported_tokens: int = 0
    total_cost_usd: float = 0.0
    duration_ms: int = 0
    duration_api_ms: int = 0

    @classmethod
    def from_result(cls, result: Dict[str, Any]) -> "TokenMetrics":
        usage = result.get("usage") or {}
        input_tokens = int(usage.get("input_tokens") or 0)
        output_tokens = int(usage.get("output_tokens") or 0)
        cache_creation = int(usage.get("cache_creation_input_tokens") or 0)
        cache_read = int(usage.get("cache_read_input_tokens") or 0)
        return cls(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_creation_input_tokens=cache_creation,
            cache_read_input_tokens=cache_read,
            new_input_output_tokens=input_tokens + output_tokens,
            total_reported_tokens=input_tokens + output_tokens + cache_creation + cache_read,
            total_cost_usd=float(result.get("total_cost_usd") or 0.0),
            duration_ms=int(result.get("duration_ms") or 0),
            duration_api_ms=int(result.get("duration_api_ms") or 0),
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class SessionRunResult:
    """Execution result for one benchmark session."""

    session: int
    turns_file: str
    turn_count: int
    exit_code: int
    duration_sec: float
    stdout: str
    stderr: str
    stream_json_log: str
    cli_result_json: Optional[str]
    subtype: Optional[str]
    is_error: bool
    session_id: Optional[str]
    num_turns: Optional[int]
    stop_reason: Optional[str]
    total_cost_usd: float
    usage: Dict[str, Any]
    modelUsage: Dict[str, Any]
    permission_denials: List[Any] = field(default_factory=list)
    errors: List[Any] = field(default_factory=list)
    token_metrics: Dict[str, Any] = field(default_factory=dict)
    diff: Optional[str] = None
    workspace_delta: Optional[str] = None
    environment_root: Optional[str] = None
    memory_snapshot: Optional[str] = None
    memory_diff: Optional[str] = None
    openviking_snapshot: Optional[str] = None
    openviking_identity: Optional[Dict[str, Any]] = None
    memory_settle: Optional[Dict[str, Any]] = None
    files_changed: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class CaseRunResult:
    """Execution result for all sessions of one case and variant."""

    scenario_id: str
    case_id: str
    variant: str
    run_environment: Dict[str, Any]
    sessions: List[SessionRunResult]
    final_diff: Optional[str] = None
    final_memory_snapshot: Optional[str] = None
    final_openviking_snapshot: Optional[str] = None
    prepared_snapshot: Optional[str] = None
    prepared_provenance: Optional[str] = None
    test_result: Optional[Dict[str, Any]] = None
    memory_backend: Optional[str] = None
    openviking_identity: Optional[Dict[str, Any]] = None
    errors: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["sessions"] = [session.to_dict() for session in self.sessions]
        return data
