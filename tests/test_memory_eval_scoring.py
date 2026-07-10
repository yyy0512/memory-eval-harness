import json

import pytest

from locobench.memory_eval.io import read_json, write_json, write_jsonl
from locobench.memory_eval.runner import snapshot_prepared_inputs
from locobench.memory_eval.scoring import classify_session_failures, openviking_isolation_state, score_runs


OBSOLETE_METRICS = {
    "final_task_completion",
    "cross_session_continuity",
    "memory_write_quality",
    "memory_usage_evidence",
}


def test_openviking_isolation_requires_run_namespace_in_identity():
    base = {
        "case_id": "case_1",
        "openviking_identity": {
            "user": "prefix-openviking_on-case_1",
            "peer_id": "prefix-openviking_on-case_1",
        },
    }
    legacy = openviking_isolation_state(base, "openviking_on")
    scoped = openviking_isolation_state(
        {
            **base,
            "openviking_identity": {
                "user": "prefix-run_1-openviking_on-case_1",
                "peer_id": "prefix-run_1-openviking_on-case_1",
                "run_namespace": "run_1",
            },
        },
        "openviking_on",
    )

    assert legacy["status"] == "partial"
    assert scoped["score"] == 1.0
    assert scoped["status"] == "pass"


def _write_case(run_dir, case_id, input_tokens, output_tokens, cost):
    harness = run_dir / case_id / "harness"
    logs = harness / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    (logs / "session_1.stream.jsonl").write_text(
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "tool_use", "name": "Read", "input": {}},
                        {"type": "tool_use", "name": "Bash", "input": {}},
                    ]
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )
    write_json(
        harness / "result.json",
        {
            "scenario_id": case_id,
            "case_id": case_id,
            "variant": run_dir.name,
            "run_environment": {"home_isolation": "per_session"},
            "sessions": [
                {
                    "session": 1,
                    "exit_code": 0,
                    "is_error": False,
                    "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
                    "total_cost_usd": cost,
                    "token_metrics": {"duration_ms": 1000, "duration_api_ms": 800},
                    "stream_json_log": "logs/session_1.stream.jsonl",
                }
            ],
        },
    )


def _write_rich_case(
    run_dir,
    case_id="case_1",
    variant=None,
    permission_denials=None,
    exit_code=0,
    subtype="success",
    is_error=None,
    errors=None,
    test_result=None,
):
    variant = variant or run_dir.name
    is_error = exit_code != 0 if is_error is None else is_error
    errors = ["failed"] if errors is None and exit_code != 0 else errors or []
    harness = run_dir / case_id / "harness"
    logs = harness / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    (logs / "session_1.stream.jsonl").write_text(
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "tool_use", "name": "Read", "input": {}},
                        {"type": "tool_use", "name": "Edit", "input": {}},
                    ]
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (logs / "session_2.stream.jsonl").write_text(
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "tool_use", "name": "Glob", "input": {}},
                        {"type": "tool_use", "name": "Bash", "input": {}},
                    ]
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )
    memory_1 = harness / "snapshots" / "session_1_memory"
    memory_2 = harness / "snapshots" / "session_2_memory"
    final_memory = harness / "snapshots" / "final_memory"
    for snapshot in (memory_1, memory_2, final_memory):
        snapshot.mkdir(parents=True, exist_ok=True)
        (snapshot / "project.md").write_text(
            "# Project memory\n- implemented rate limiter module\n- preserve API error envelope with error code message\n",
            encoding="utf-8",
        )
    (harness / "snapshots" / "final.diff").parent.mkdir(parents=True, exist_ok=True)
    (harness / "snapshots" / "final.diff").write_text("diff --git a/file b/file\n", encoding="utf-8")
    for session in (1, 2):
        delta = harness / "snapshots" / f"session_{session}_workspace_delta"
        (delta / "files").mkdir(parents=True, exist_ok=True)
        write_json(
            delta / "manifest.json",
            {
                "schema_version": "memory_eval_workspace_delta_v1",
                "added": [],
                "modified": [],
                "deleted": [],
                "copied": [],
                "copy_errors": [],
            },
        )
    write_json(
        harness / "result.json",
        {
            "scenario_id": case_id,
            "case_id": case_id,
            "variant": variant,
            "run_environment": {"home_isolation": "per_session"},
            "sessions": [
                {
                    "session": 1,
                    "exit_code": 0,
                    "is_error": False,
                    "cli_result_json": "logs/session_1.result.json",
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 5,
                        "cache_creation_input_tokens": 2,
                        "cache_read_input_tokens": 3,
                    },
                    "total_cost_usd": 0.1,
                    "duration_sec": 1.5,
                    "token_metrics": {
                        "duration_ms": 1000,
                        "duration_api_ms": 800,
                        "new_input_output_tokens": 15,
                        "total_reported_tokens": 20,
                    },
                    "stream_json_log": "logs/session_1.stream.jsonl",
                    "workspace_delta": "snapshots/session_1_workspace_delta",
                    "memory_snapshot": "snapshots/session_1_memory",
                    "files_changed": ["src/rate_limiter.c", "include/rate_limiter.h"],
                    "permission_denials": [],
                    "errors": [],
                },
                {
                    "session": 2,
                    "exit_code": exit_code,
                    "is_error": is_error,
                    "cli_result_json": "logs/session_2.result.json" if exit_code == 0 else None,
                    "subtype": subtype,
                    "usage": {
                        "input_tokens": 20,
                        "output_tokens": 7,
                        "cache_creation_input_tokens": 4,
                        "cache_read_input_tokens": 6,
                    },
                    "total_cost_usd": 0.2,
                    "duration_sec": 2.5,
                    "token_metrics": {
                        "duration_ms": 2000,
                        "duration_api_ms": 1600,
                        "new_input_output_tokens": 27,
                        "total_reported_tokens": 37,
                    },
                    "stream_json_log": "logs/session_2.stream.jsonl",
                    "workspace_delta": "snapshots/session_2_workspace_delta",
                    "memory_snapshot": "snapshots/session_2_memory",
                    "files_changed": ["src/rate_limiter.c", "tests/test_rate_limiter.c"],
                    "permission_denials": permission_denials or [],
                    "errors": errors,
                },
            ],
            "final_diff": "snapshots/final.diff",
            "final_memory_snapshot": "snapshots/final_memory",
            "test_result": test_result,
            "errors": [],
        },
    )


def _write_prepared_reference(prepared_dir, scenario_id):
    write_json(
        prepared_dir / "summary.json",
        {
            "dataset_stats": {
                "difficulty_distribution": {"hard": 1},
                "task_type_distribution": {"multi_session_development": 1},
                "programming_language_distribution": {"c": 1},
                "contract_stats": {
                    "contracts_per_case_distribution": {"0": 1},
                    "contract_id_distribution": {},
                    "contract_category_distribution": {},
                    "case_contracts": [],
                },
                "test_availability_stats": {"with_test_like_files": 1},
            }
        },
    )
    write_json(
        prepared_dir / "cases" / scenario_id / "scoring_reference.json",
        {
            "scenario_id": scenario_id,
            "ground_truth": "RAW_GROUND_TRUTH_SENTINEL",
            "expected_approach": "RAW_EXPECTED_APPROACH_SENTINEL",
            "evaluation_criteria": ["RAW_CRITERIA_SENTINEL"],
            "expected_memory_facts": [
                {
                    "id": "rate_limiter_memory",
                    "required_keywords": ["rate limiter", "error", "code", "message"],
                }
            ],
        },
    )


def test_score_runs_computes_memory_on_off_deltas_and_new_report(tmp_path):
    memory_on = tmp_path / "memory_on"
    memory_off = tmp_path / "memory_off"
    prepared = tmp_path / "prepared"
    _write_case(memory_on, "case_1", 10, 5, 0.1)
    _write_case(memory_off, "case_1", 25, 7, 0.3)
    _write_prepared_reference(prepared, "case_1")

    report = score_runs([memory_on, memory_off], tmp_path / "report.json", prepared_dir=prepared)

    assert report["schema_version"] == "memory_eval_scoring_v10_session_contracts"
    assert report["variants"]["memory_on"]["case_count"] == 1
    assert report["variants"]["memory_on"]["run_completion"]["cli_completed_cases"] == 1
    assert report["variants"]["memory_on"]["run_completion"]["test_valid_cases"] == 0
    assert report["variants"]["memory_on"]["run_completion"]["task_passed_cases"] == 0
    assert report["llm_judge_enabled"] is False
    assert "llm_judge" not in report["cases"][0]
    comparison = report["comparisons"]["memory_off_vs_memory_on"]
    assert comparison["deltas"]["input_token_delta"] == -15
    assert comparison["deltas"]["output_token_delta"] == -2
    assert round(comparison["deltas"]["cost_delta_usd"], 6) == -0.2
    assert comparison["deltas"]["tool_call_count_delta"] == 0
    assert report["dataset_stats"]["difficulty_distribution"] == {"hard": 1}
    assert (tmp_path / "report.md").exists()
    assert (tmp_path / "readable_report.md").exists()
    readable = (tmp_path / "readable_report.md").read_text(encoding="utf-8")
    assert "## 2. 数据集基础统计" in readable
    assert "## 4. 核心质量指标" in readable
    assert "Delta %" in readable
    assert "测试文件可用性" in readable
    assert "CLI completed" in readable
    assert "指标中文名 | 指标统计口径 | 指标计算公式" in readable
    for metric_name in OBSOLETE_METRICS:
        assert metric_name not in readable


def test_score_runs_reports_progress(tmp_path):
    memory_on = tmp_path / "memory_on"
    _write_case(memory_on, "case_1", 10, 5, 0.1)
    _write_case(memory_on, "case_2", 12, 6, 0.2)
    messages = []

    score_runs([memory_on], tmp_path / "report.json", progress=messages.append)

    assert messages == [
        "Scoring variant memory_on: collecting cases",
        "Scoring variant memory_on: 2 case(s)",
        "Scoring variant memory_on: case 1/2 case_1",
        "Scoring variant memory_on: case 2/2 case_2",
        f"Writing report to {tmp_path / 'report.json'}",
        f"Writing readable report to {tmp_path / 'readable_report.md'}",
    ]


def test_strict_scoring_uses_embedded_prepared_snapshot_and_detects_mutation(tmp_path):
    run_dir = tmp_path / "memory_off"
    prepared = tmp_path / "prepared"
    _write_rich_case(run_dir)
    _write_prepared_reference(prepared, "case_1")
    manifest_entry = {
        "scenario_id": "case_1",
        "case_id": "case_1",
        "hashes": {},
        "turns": [],
    }
    write_jsonl(prepared / "manifest.jsonl", [manifest_entry])
    harness = run_dir / "case_1" / "harness"
    provenance = snapshot_prepared_inputs(prepared, manifest_entry, harness)
    result_path = harness / "result.json"
    result = read_json(result_path)
    result["prepared_snapshot"] = "prepared_snapshot/case"
    result["prepared_provenance"] = "prepared_snapshot/provenance.json"
    result["run_environment"]["prepared_dataset_sha256"] = provenance["prepared_dataset_sha256"]
    result["run_environment"]["prepared_case_sha256"] = provenance["prepared_case_sha256"]
    write_json(result_path, result)

    report = score_runs(
        [run_dir],
        tmp_path / "verified.json",
        prepared_dir=prepared,
        strict_provenance=True,
    )
    assert report["cases"][0]["provenance"]["status"] == "verified"

    reference_path = prepared / "cases" / "case_1" / "scoring_reference.json"
    reference = read_json(reference_path)
    reference["ground_truth"] = "mutated"
    write_json(reference_path, reference)
    with pytest.raises(ValueError, match="differs from run snapshot"):
        score_runs(
            [run_dir],
            tmp_path / "rejected.json",
            prepared_dir=prepared,
            strict_provenance=True,
        )


def test_score_runs_uses_new_core_metrics_and_avoids_reference_leakage(tmp_path):
    memory_on = tmp_path / "memory_on"
    memory_off = tmp_path / "memory_off"
    prepared = tmp_path / "prepared"
    _write_rich_case(memory_on)
    _write_rich_case(memory_off)
    _write_prepared_reference(prepared, "case_1")

    report = score_runs([memory_on, memory_off], tmp_path / "report.json", prepared_dir=prepared)

    metrics = report["variants"]["memory_on"]["metrics"]
    assert set(metrics) == {
        "contract_compliance",
        "test_runnable_rate",
        "test_pass_rate",
        "requirement_rule_coverage",
        "memory_content_quality",
    }
    assert report["variants"]["memory_on"]["token_totals"]["cache_read_input_tokens"] == 9
    assert report["variants"]["memory_on"]["token_totals"]["new_input_output_tokens"] == 42
    assert report["variants"]["memory_on"]["tool_totals"]["tool_call_count"] == 4
    assert report["variants"]["memory_on"]["tool_totals"]["search_or_read_tool_call_count"] == 2
    assert report["variants"]["memory_on"]["tool_totals"]["bash_tool_call_count"] == 1
    assert report["variants"]["memory_on"]["tool_totals"]["edit_tool_call_count"] == 1
    assert report["variants"]["memory_on"]["metrics"]["memory_content_quality"]["mean"] == 1.0
    assert report["cases"][0]["reference"]["present"] is True
    assert report["cases"][0]["reference"]["fingerprint"].startswith("sha256:")

    serialized = json.dumps(report, ensure_ascii=False)
    markdown = (tmp_path / "report.md").read_text(encoding="utf-8")
    assert "RAW_GROUND_TRUTH_SENTINEL" not in serialized
    assert "RAW_EXPECTED_APPROACH_SENTINEL" not in serialized
    assert "RAW_CRITERIA_SENTINEL" not in serialized
    assert "RAW_GROUND_TRUTH_SENTINEL" not in markdown


def test_score_runs_adds_contract_compliance_metric(tmp_path):
    memory_on = tmp_path / "memory_on"
    memory_off = tmp_path / "memory_off"
    prepared = tmp_path / "prepared"
    _write_rich_case(memory_on)
    _write_rich_case(memory_off)
    for run_dir, body in (
        (memory_on, 'export const payload = { error: { code: "E_RATE", message: "limited" } };\n'),
        (memory_off, 'export const payload = { message: "limited" };\n'),
    ):
        source = run_dir / "case_1" / "agent_root" / "workspace" / "src" / "handler.ts"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text(body, encoding="utf-8")
        delta_source = run_dir / "case_1" / "harness" / "snapshots" / "session_2_workspace_delta" / "files" / "src" / "handler.ts"
        delta_source.parent.mkdir(parents=True, exist_ok=True)
        delta_source.write_text(body, encoding="utf-8")
        manifest_path = delta_source.parents[2] / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["modified"] = ["src/handler.ts"]
        manifest["copied"] = ["src/handler.ts"]
        write_json(manifest_path, manifest)
    write_json(
        prepared / "cases" / "case_1" / "scoring_reference.json",
        {
            "scenario_id": "case_1",
            "memory_contracts": [
                {
                    "id": "api_error_envelope",
                    "introduced_in_session": 1,
                    "description": "All new API errors must use { error: { code, message } }.",
                    "checks": [
                        {
                            "type": "require_regex",
                            "path_glob": "src/**/handler.ts",
                            "pattern": "error\\s*:\\s*\\{\\s*code\\s*:",
                        },
                        {
                            "type": "forbid_regex",
                            "path_glob": "src/**/handler.ts",
                            "pattern": "\\{\\s*message\\s*:",
                        },
                    ],
                }
            ],
        },
    )

    report = score_runs([memory_on, memory_off], tmp_path / "report.json", prepared_dir=prepared)

    assert report["variants"]["memory_on"]["metrics"]["contract_compliance"]["mean"] == 1.0
    assert report["variants"]["memory_off"]["metrics"]["contract_compliance"]["mean"] == 0.0
    assert report["comparisons"]["memory_off_vs_memory_on"]["deltas"]["contract_compliance_delta"] == 1.0
    assert report["cases"][0]["metrics"]["contract_compliance"]["status"] == "pass"
    assert report["cases"][1]["metrics"]["contract_compliance"]["status"] == "fail"
    markdown = (tmp_path / "report.md").read_text(encoding="utf-8")
    assert "Contract 遵从率" in markdown


def test_contract_compliance_uses_equal_contract_weights(tmp_path):
    run_dir = tmp_path / "memory_on"
    prepared = tmp_path / "prepared"
    _write_rich_case(run_dir)
    delta = run_dir / "case_1" / "harness" / "snapshots" / "session_2_workspace_delta"
    source = delta / "files" / "src" / "handler.ts"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("ALPHA\nBETA\n", encoding="utf-8")
    manifest = read_json(delta / "manifest.json")
    manifest["modified"] = ["src/handler.ts"]
    manifest["copied"] = ["src/handler.ts"]
    write_json(delta / "manifest.json", manifest)
    write_json(
        prepared / "cases" / "case_1" / "scoring_reference.json",
        {
            "scenario_id": "case_1",
            "memory_contracts": [
                {
                    "id": "two_checks",
                    "checks": [
                        {"type": "require_regex", "path_glob": "src/**/handler.ts", "pattern": "ALPHA"},
                        {"type": "require_regex", "path_glob": "src/**/handler.ts", "pattern": "MISSING"},
                    ],
                },
                {
                    "id": "one_check",
                    "checks": [
                        {"type": "require_regex", "path_glob": "src/**/handler.ts", "pattern": "BETA"}
                    ],
                },
            ],
        },
    )

    report = score_runs([run_dir], tmp_path / "report.json", prepared_dir=prepared)

    assert report["cases"][0]["metrics"]["contract_compliance"]["score"] == 0.75


def test_contract_compliance_scores_each_applicable_session_and_reports_final_failure(tmp_path):
    run_dir = tmp_path / "memory_on"
    prepared = tmp_path / "prepared"
    _write_rich_case(run_dir)
    harness = run_dir / "case_1" / "harness"

    session_2_delta = harness / "snapshots" / "session_2_workspace_delta"
    session_2_source = session_2_delta / "files" / "src" / "handler.ts"
    session_2_source.parent.mkdir(parents=True, exist_ok=True)
    session_2_source.write_text("// TOMATO_KEEP\n", encoding="utf-8")
    session_2_manifest = read_json(session_2_delta / "manifest.json")
    session_2_manifest["modified"] = ["src/handler.ts"]
    session_2_manifest["copied"] = ["src/handler.ts"]
    write_json(session_2_delta / "manifest.json", session_2_manifest)

    session_3_delta = harness / "snapshots" / "session_3_workspace_delta"
    (session_3_delta / "files").mkdir(parents=True)
    write_json(
        session_3_delta / "manifest.json",
        {
            "schema_version": "memory_eval_workspace_delta_v1",
            "added": [],
            "modified": [],
            "deleted": ["src/handler.ts"],
            "copied": [],
            "copy_errors": [],
        },
    )
    result_path = harness / "result.json"
    result = read_json(result_path)
    result["sessions"].append(
        {
            "session": 3,
            "exit_code": 0,
            "is_error": False,
            "workspace_delta": "snapshots/session_3_workspace_delta",
        }
    )
    write_json(result_path, result)
    (run_dir / "case_1" / "agent_root" / "workspace").mkdir(parents=True, exist_ok=True)
    write_json(
        prepared / "cases" / "case_1" / "scoring_reference.json",
        {
            "scenario_id": "case_1",
            "memory_contracts": [
                {
                    "id": "keep_marker",
                    "introduced_in_session": 1,
                    "workspace_effective_from_session": 2,
                    "checks": [
                        {
                            "type": "require_regex",
                            "path_glob": "**/*",
                            "pattern": "TOMATO_KEEP",
                        }
                    ],
                }
            ],
        },
    )

    report = score_runs([run_dir], tmp_path / "report.json", prepared_dir=prepared)
    metric = report["cases"][0]["metrics"]["contract_compliance"]

    assert metric["score"] == 0.5
    evidence = " ".join(metric["evidence"])
    assert "session_2 pass" in evidence
    assert "session_3 fail" in evidence
    assert "final_state=fail" in evidence


def test_contract_compliance_rejects_negative_only_contract(tmp_path):
    run_dir = tmp_path / "memory_off"
    prepared = tmp_path / "prepared"
    _write_rich_case(run_dir)
    write_json(
        prepared / "cases" / "case_1" / "scoring_reference.json",
        {
            "scenario_id": "case_1",
            "memory_contracts": [
                {
                    "id": "negative_only",
                    "checks": [
                        {"type": "forbid_regex", "path_glob": "src/**/*", "pattern": "BAD_SENTINEL"}
                    ],
                }
            ],
        },
    )

    report = score_runs([run_dir], tmp_path / "report.json", prepared_dir=prepared)
    metric = report["cases"][0]["metrics"]["contract_compliance"]

    assert metric["score"] is None
    assert "only negative" in " ".join(metric["evidence"])


def test_contract_compliance_excludes_marker_materialized_in_introduction_session(tmp_path):
    run_dir = tmp_path / "memory_on"
    prepared = tmp_path / "prepared"
    _write_rich_case(run_dir)
    for session in (1, 2):
        delta = run_dir / "case_1" / "harness" / "snapshots" / f"session_{session}_workspace_delta"
        source = delta / "files" / "src" / "handler.ts"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text("// TOMATO_SENTINEL\n", encoding="utf-8")
        manifest = json.loads((delta / "manifest.json").read_text(encoding="utf-8"))
        manifest["modified"] = ["src/handler.ts"]
        manifest["copied"] = ["src/handler.ts"]
        write_json(delta / "manifest.json", manifest)
    write_json(
        prepared / "cases" / "case_1" / "scoring_reference.json",
        {
            "scenario_id": "case_1",
            "memory_contracts": [
                {
                    "id": "later_marker",
                    "introduced_in_session": 1,
                    "workspace_effective_from_session": 2,
                    "checks": [
                        {
                            "type": "require_regex",
                            "path_glob": "src/**/handler.ts",
                            "pattern": "TOMATO_SENTINEL",
                        }
                    ],
                }
            ],
        },
    )

    report = score_runs([run_dir], tmp_path / "report.json", prepared_dir=prepared)
    metric = report["cases"][0]["metrics"]["contract_compliance"]

    assert metric["score"] is None
    assert metric["status"] == "not_applicable"
    assert "introduction-session workspace already satisfied" in " ".join(metric["evidence"])


def test_contract_compliance_marks_legacy_final_workspace_only_run_not_applicable(tmp_path):
    run_dir = tmp_path / "memory_off"
    prepared = tmp_path / "prepared"
    _write_case(run_dir, "case_1", 1, 1, 0.0)
    source = run_dir / "case_1" / "agent_root" / "workspace" / "src" / "handler.ts"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("// TOMATO_SENTINEL\n", encoding="utf-8")
    write_json(
        prepared / "cases" / "case_1" / "scoring_reference.json",
        {
            "scenario_id": "case_1",
            "memory_contracts": [
                {
                    "id": "later_marker",
                    "checks": [
                        {"type": "require_regex", "path_glob": "**/*", "pattern": "TOMATO_SENTINEL"}
                    ],
                }
            ],
        },
    )

    report = score_runs([run_dir], tmp_path / "report.json", prepared_dir=prepared)
    metric = report["cases"][0]["metrics"]["contract_compliance"]

    assert metric["score"] is None
    assert "legacy final-workspace artifacts cannot prove" in " ".join(metric["evidence"])


def test_contract_compliance_ignores_memory_fact_evidence(tmp_path):
    memory_on = tmp_path / "memory_on"
    memory_off = tmp_path / "memory_off"
    prepared = tmp_path / "prepared"
    _write_rich_case(memory_on)
    _write_rich_case(memory_off)
    write_json(
        prepared / "cases" / "case_1" / "scoring_reference.json",
        {
            "scenario_id": "case_1",
            "memory_contracts": [
                {
                    "id": "project_exact_identifier_ledger",
                    "memory_type": "project",
                    "description": "Project memory: remember exact identifiers.",
                    "expected_memory_fact": {
                        "required_keywords": ["Project memory", "rate limiter", "error", "code"]
                    },
                }
            ],
            "expected_memory_facts": [
                {
                    "id": "project_exact_identifier_ledger",
                    "required_keywords": ["Project memory", "rate limiter", "error", "code"],
                }
            ],
        },
    )

    report = score_runs([memory_on, memory_off], tmp_path / "report.json", prepared_dir=prepared)

    assert report["variants"]["memory_on"]["metrics"]["contract_compliance"]["mean"] is None
    assert report["variants"]["memory_off"]["metrics"]["contract_compliance"]["mean"] is None
    assert report["variants"]["memory_on"]["metrics"]["contract_compliance"]["numeric_count"] == 0
    assert report["variants"]["memory_off"]["metrics"]["contract_compliance"]["numeric_count"] == 0
    memory_on_case = next(case for case in report["cases"] if case["variant"] == "memory_on")
    evidence = " ".join(memory_on_case["metrics"]["contract_compliance"]["evidence"])
    assert "workspace_checks=0" in evidence
    assert "no later-session workspace/output checks configured" in evidence


def test_contract_compliance_scores_only_workspace_evidence(tmp_path):
    run_dir = tmp_path / "memory_on"
    prepared = tmp_path / "prepared"
    _write_rich_case(run_dir)
    source = run_dir / "case_1" / "agent_root" / "workspace" / "src" / "handler.ts"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text('export const payload = { message: "limited" };\n', encoding="utf-8")
    delta = run_dir / "case_1" / "harness" / "snapshots" / "session_2_workspace_delta"
    delta_source = delta / "files" / "src" / "handler.ts"
    delta_source.parent.mkdir(parents=True, exist_ok=True)
    delta_source.write_text('export const payload = { message: "limited" };\n', encoding="utf-8")
    manifest = read_json(delta / "manifest.json")
    manifest["modified"] = ["src/handler.ts"]
    manifest["copied"] = ["src/handler.ts"]
    write_json(delta / "manifest.json", manifest)
    write_json(
        prepared / "cases" / "case_1" / "scoring_reference.json",
        {
            "scenario_id": "case_1",
            "memory_contracts": [
                {
                    "id": "api_error_handoff",
                    "memory_type": "project",
                    "description": "Project memory and workspace must preserve API error envelope.",
                    "expected_memory_fact": {"required_keywords": ["Project memory", "error", "code"]},
                    "checks": [
                        {
                            "type": "require_regex",
                            "path_glob": "src/**/handler.ts",
                            "pattern": "error\\s*:\\s*\\{\\s*code\\s*:",
                        }
                    ],
                }
            ],
        },
    )

    report = score_runs([run_dir], tmp_path / "report.json", prepared_dir=prepared)

    metric = report["cases"][0]["metrics"]["contract_compliance"]
    assert metric["score"] == 0.0
    assert metric["status"] == "fail"
    evidence = " ".join(metric["evidence"])
    assert "contract compliance fully-passed checks: 0/1" in evidence
    assert "workspace_checks=1" in evidence
    assert "memory_facts" not in evidence


def test_score_runs_classifies_failure_profile_without_task_completion_metric(tmp_path):
    memory_on = tmp_path / "memory_on"
    _write_rich_case(memory_on, permission_denials=[{"tool": "Bash"}], exit_code=1)

    report = score_runs([memory_on], tmp_path / "report.json")

    profile = report["variants"]["memory_on"]["failure_profile"]
    assert profile["by_reason"]["no_result_event"] == 1
    assert profile["by_reason"]["nonzero_exit"] == 1
    assert profile["by_reason"]["is_error_flag"] == 1
    assert profile["by_reason"]["permission_denied"] == 1
    for metric_name in OBSOLETE_METRICS:
        assert metric_name not in report["variants"]["memory_on"]["metrics"]


def test_classify_session_failures_can_ignore_nonfatal_memory_off_memory_denials():
    session = {
        "session": 2,
        "exit_code": 0,
        "is_error": False,
        "subtype": "success",
        "cli_result_json": "logs/session_2.result.json",
        "permission_denials": [
            {
                "tool_name": "Write",
                "tool_input": {"file_path": "/home/user/.cac/projects/example/session_memory.md"},
            }
        ],
        "errors": [],
    }

    assert classify_session_failures(session) == ["permission_denied"]
    assert classify_session_failures(
        session,
        variant="memory_off",
        ignore_nonfatal_memory_denials=True,
    ) == []
    assert classify_session_failures(
        session,
        variant="memory_on",
        ignore_nonfatal_memory_denials=True,
    ) == ["permission_denied"]


def test_obsolete_memory_proxy_metrics_are_removed(tmp_path):
    memory_off = tmp_path / "memory_off"
    _write_rich_case(memory_off)

    report = score_runs([memory_off], tmp_path / "report.json")

    case_metrics = report["cases"][0]["metrics"]
    for metric_name in OBSOLETE_METRICS:
        assert metric_name not in case_metrics
        assert metric_name not in report["variants"]["memory_off"]["metrics"]

def test_requirement_rule_coverage_uses_plan_reason_when_not_configured(tmp_path):
    run_dir = tmp_path / "memory_off"
    prepared = tmp_path / "prepared"
    _write_rich_case(run_dir)
    write_json(
        prepared / "cases" / "case_1" / "scoring_reference.json",
        {
            "scenario_id": "case_1",
            "requirement_checks": [],
            "requirement_check_plan": {
                "status": "not_configured",
                "source": "auto_strong_signal",
                "reason": "no_strong_requirement_signals",
                "rejected_terms": [{"term": "context", "reason": "generic_term"}],
            },
        },
    )
    write_json(
        prepared / "summary.json",
        {
            "dataset_stats": {
                "requirement_check_stats": {
                    "checks_per_case_distribution": {"0": 1},
                    "status_distribution": {"not_configured": 1},
                    "source_distribution": {},
                    "strength_distribution": {},
                    "signal_kind_distribution": {},
                    "rejection_reason_distribution": {"generic_term": 1},
                    "configured_cases": 0,
                    "not_configured_cases": 1,
                    "case_requirement_checks": [
                        {
                            "case_id": "case_1",
                            "status": "not_configured",
                            "source": "auto_strong_signal",
                            "check_count": 0,
                            "reason": "no_strong_requirement_signals",
                            "signal_kinds": [],
                            "strengths": [],
                        }
                    ],
                }
            }
        },
    )

    report = score_runs([run_dir], tmp_path / "report.json", prepared_dir=prepared)

    metric = report["cases"][0]["metrics"]["requirement_rule_coverage"]
    assert metric["score"] is None
    assert "no_strong_requirement_signals" in " ".join(metric["evidence"])
    readable = (tmp_path / "readable_report.md").read_text(encoding="utf-8")
    assert "Requirement checks rejected term 原因分布" in readable
    assert "no_strong_requirement_signals" in readable


def test_requirement_rule_coverage_evidence_includes_metadata(tmp_path):
    run_dir = tmp_path / "memory_on"
    prepared = tmp_path / "prepared"
    _write_rich_case(run_dir)
    source = run_dir / "case_1" / "agent_root" / "workspace" / "src" / "rate_limiter.c"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("#define RATE_LIMIT_EXCEEDED 429\n", encoding="utf-8")
    delta = run_dir / "case_1" / "harness" / "snapshots" / "session_2_workspace_delta"
    delta_source = delta / "files" / "src" / "rate_limiter.c"
    delta_source.parent.mkdir(parents=True, exist_ok=True)
    delta_source.write_text("#define RATE_LIMIT_EXCEEDED 429\n", encoding="utf-8")
    manifest = read_json(delta / "manifest.json")
    manifest["added"] = ["src/rate_limiter.c"]
    manifest["copied"] = ["src/rate_limiter.c"]
    write_json(delta / "manifest.json", manifest)
    write_json(
        prepared / "cases" / "case_1" / "scoring_reference.json",
        {
            "scenario_id": "case_1",
            "requirement_checks": [
                {
                    "id": "has_rate_limit_exceeded",
                    "type": "require_regex",
                    "path_glob": "src/**/*.c",
                    "pattern": "RATE_LIMIT_EXCEEDED",
                    "source": "overlay",
                    "strength": "explicit",
                    "signal_kind": "error_code",
                    "rationale": "rate limit exceeded behavior must be represented",
                }
            ],
        },
    )

    report = score_runs([run_dir], tmp_path / "report.json", prepared_dir=prepared)

    metric = report["cases"][0]["metrics"]["requirement_rule_coverage"]
    assert metric["score"] == 1.0
    evidence = " ".join(metric["evidence"])
    assert "source=overlay" in evidence
    assert "strength=explicit" in evidence
    assert "kind=error_code" in evidence


def test_requirement_rule_coverage_rejects_negative_only_checks(tmp_path):
    run_dir = tmp_path / "memory_off"
    prepared = tmp_path / "prepared"
    _write_rich_case(run_dir)
    write_json(
        prepared / "cases" / "case_1" / "scoring_reference.json",
        {
            "scenario_id": "case_1",
            "requirement_checks": [
                {"id": "no_bad", "type": "forbid_regex", "path_glob": "**/*", "pattern": "BAD"}
            ],
        },
    )

    report = score_runs([run_dir], tmp_path / "report.json", prepared_dir=prepared)
    metric = report["cases"][0]["metrics"]["requirement_rule_coverage"]

    assert metric["score"] is None
    assert "negative-only" in " ".join(metric["evidence"])

    env_issue = tmp_path / "memory_off"
    integrity_issue = tmp_path / "openviking_on"
    _write_rich_case(
        env_issue,
        test_result={
            "status": "skipped",
            "command": ["make", "test"],
            "environment_status": "missing_system_dependency",
            "integrity_status": "passed",
            "failure_classification": "missing_system_dependency",
            "missing_dependency": "microhttpd.h",
            "source": "makefile_test_target",
        },
    )
    _write_rich_case(
        integrity_issue,
        test_result={
            "status": "invalid",
            "command": ["make", "test"],
            "environment_status": "ready",
            "integrity_status": "failed",
            "integrity_reason": "original_test_runner_removed_or_narrowed",
            "source": "makefile_test_target",
        },
    )

    report = score_runs([env_issue, integrity_issue], tmp_path / "report.json")

    assert report["variants"]["memory_off"]["metrics"]["test_pass_rate"]["mean"] is None
    assert report["variants"]["openviking_on"]["metrics"]["test_pass_rate"]["mean"] is None
    assert report["variants"]["memory_off"]["test_result_status"]["environment_distribution"] == {"missing_system_dependency": 1}
    assert report["variants"]["openviking_on"]["test_result_status"]["integrity_distribution"] == {"failed": 1}
    readable = (tmp_path / "readable_report.md").read_text(encoding="utf-8")

def _write_fake_judge(path, payload, exit_code=0):
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        "_prompt = sys.stdin.read()\n"
        f"sys.stdout.write({json.dumps(json.dumps(payload))})\n"
        f"raise SystemExit({exit_code})\n",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _write_prompt_capture_judge(path, prompt_path, payload):
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        "prompt = sys.stdin.read()\n"
        f"with open({json.dumps(str(prompt_path))}, 'a', encoding='utf-8') as handle:\n"
        "    handle.write(prompt)\n"
        "    handle.write('\\n---PROMPT---\\n')\n"
        f"sys.stdout.write({json.dumps(json.dumps(payload))})\n",
        encoding="utf-8",
    )
    path.chmod(0o755)


def test_score_runs_can_add_pairwise_llm_judge_without_leaking_reference(tmp_path):
    memory_on = tmp_path / "memory_on"
    memory_off = tmp_path / "memory_off"
    prepared = tmp_path / "prepared"
    _write_rich_case(memory_on)
    _write_rich_case(memory_off)
    _write_prepared_reference(prepared, "case_1")
    judge = tmp_path / "judge.py"
    _write_fake_judge(
        judge,
        {
            "verdict": "B_better",
            "rationale": "Submission B better satisfies the visible requirements.",
            "evidence": ["Final diff is more complete."],
        },
    )

    report = score_runs(
        [memory_on, memory_off],
        tmp_path / "report.json",
        prepared_dir=prepared,
        llm_judge={"enabled": True, "command": [str(judge)], "timeout_sec": 30, "max_chars": 8000},
    )

    pairwise = report["comparisons"]["memory_off_vs_memory_on"]["blind_llm_pairwise"]
    assert report["llm_judge_enabled"] is True
    assert pairwise["summary"]["wins"] == 0
    assert pairwise["summary"]["judge_uncertain"] == 1
    assert len(pairwise["cases"][0]["position_checks"]) == 2
    assert "llm_metrics" not in report["variants"]["memory_on"]
    serialized = json.dumps(report, ensure_ascii=False)
    markdown = (tmp_path / "report.md").read_text(encoding="utf-8")
    assert "RAW_GROUND_TRUTH_SENTINEL" not in serialized
    assert "RAW_EXPECTED_APPROACH_SENTINEL" not in serialized
    assert "RAW_CRITERIA_SENTINEL" not in serialized
    assert "RAW_GROUND_TRUTH_SENTINEL" not in markdown


def test_pairwise_llm_judge_prompt_is_blinded_to_memory_variant(tmp_path):
    memory_on = tmp_path / "memory_on"
    memory_off = tmp_path / "memory_off"
    prepared = tmp_path / "prepared"
    _write_rich_case(memory_on)
    _write_rich_case(memory_off)
    _write_prepared_reference(prepared, "case_1")
    capture = tmp_path / "judge_prompts.txt"
    judge = tmp_path / "judge.py"
    _write_prompt_capture_judge(
        judge,
        capture,
        {
            "verdict": "tie",
            "rationale": "Both submissions are similar.",
            "evidence": ["Both final diffs are similar."],
        },
    )

    report = score_runs(
        [memory_on, memory_off],
        tmp_path / "report.json",
        prepared_dir=prepared,
        llm_judge={"enabled": True, "command": [str(judge)], "timeout_sec": 30, "max_chars": 8000},
    )

    prompts = capture.read_text(encoding="utf-8")
    pairwise = report["comparisons"]["memory_off_vs_memory_on"]["blind_llm_pairwise"]
    assert pairwise["summary"]["ties"] == 1
    assert "memory_on" not in prompts
    assert "memory_off" not in prompts
    assert '"variant"' not in prompts
    assert '"memory_summary"' not in prompts
    assert '"memory_excerpts"' not in prompts
    assert '"submission_A"' in prompts
    assert '"submission_B"' in prompts
    assert '"changed_file_excerpts"' in prompts
    assert '"post_run_test"' in prompts
    assert prompts.count("---PROMPT---") == 2


def test_score_runs_records_pairwise_llm_judge_command_error(tmp_path):
    memory_on = tmp_path / "memory_on"
    memory_off = tmp_path / "memory_off"
    prepared = tmp_path / "prepared"
    _write_rich_case(memory_on)
    _write_rich_case(memory_off)
    _write_prepared_reference(prepared, "case_1")
    judge = tmp_path / "judge.py"
    _write_fake_judge(judge, {"not_verdict": True}, exit_code=1)

    report = score_runs(
        [memory_on, memory_off],
        tmp_path / "report.json",
        prepared_dir=prepared,
        llm_judge={"enabled": True, "command": [str(judge)], "timeout_sec": 30, "max_chars": 8000},
    )

    pairwise = report["comparisons"]["memory_off_vs_memory_on"]["blind_llm_pairwise"]
    assert pairwise["cases"][0]["status"] == "judge_error"
    assert pairwise["cases"][0]["error"] == "judge command exited with code 1"
    assert pairwise["summary"]["judge_error_count"] == 1
