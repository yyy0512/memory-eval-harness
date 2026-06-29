import json

from locobench.memory_eval.io import write_json
from locobench.memory_eval.scoring import score_runs


def _write_case(run_dir, case_id, input_tokens, output_tokens, cost):
    write_json(
        run_dir / case_id / "harness" / "result.json",
        {
            "scenario_id": case_id,
            "case_id": case_id,
            "variant": run_dir.name,
            "run_environment": {},
            "sessions": [
                {
                    "session": 1,
                    "exit_code": 0,
                    "is_error": False,
                    "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
                    "total_cost_usd": cost,
                    "token_metrics": {"duration_ms": 1000, "duration_api_ms": 800},
                }
            ],
        },
    )


def _write_rich_case(run_dir, case_id="case_1", variant=None, permission_denials=None, exit_code=0):
    variant = variant or run_dir.name
    harness = run_dir / case_id / "harness"
    memory_1 = harness / "snapshots" / "session_1_memory"
    memory_2 = harness / "snapshots" / "session_2_memory"
    final_memory = harness / "snapshots" / "final_memory"
    for snapshot in (memory_1, memory_2, final_memory):
        snapshot.mkdir(parents=True, exist_ok=True)
        (snapshot / "project.md").write_text(
            "# Project memory\n- implemented rate limiter module\n- continue wiring tests\n",
            encoding="utf-8",
        )
    (harness / "snapshots" / "final.diff").parent.mkdir(parents=True, exist_ok=True)
    (harness / "snapshots" / "final.diff").write_text("diff --git a/file b/file\n", encoding="utf-8")
    write_json(
        harness / "result.json",
        {
            "scenario_id": case_id,
            "case_id": case_id,
            "variant": variant,
            "run_environment": {},
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
                    "memory_snapshot": "snapshots/session_1_memory",
                    "files_changed": ["src/rate_limiter.c", "include/rate_limiter.h"],
                    "permission_denials": [],
                    "errors": [],
                },
                {
                    "session": 2,
                    "exit_code": exit_code,
                    "is_error": exit_code != 0,
                    "cli_result_json": "logs/session_2.result.json" if exit_code == 0 else None,
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
                    "memory_snapshot": "snapshots/session_2_memory",
                    "files_changed": ["src/rate_limiter.c", "tests/test_rate_limiter.c"],
                    "permission_denials": permission_denials or [],
                    "errors": ["failed"] if exit_code != 0 else [],
                },
            ],
            "final_diff": "snapshots/final.diff",
            "final_memory_snapshot": "snapshots/final_memory",
            "errors": [],
        },
    )


def _write_prepared_reference(prepared_dir, scenario_id):
    write_json(
        prepared_dir / "cases" / scenario_id / "scoring_reference.json",
        {
            "scenario_id": scenario_id,
            "ground_truth": "RAW_GROUND_TRUTH_SENTINEL",
            "expected_approach": "RAW_EXPECTED_APPROACH_SENTINEL",
            "evaluation_criteria": ["RAW_CRITERIA_SENTINEL"],
        },
    )


def test_score_runs_computes_memory_on_off_deltas(tmp_path):
    memory_on = tmp_path / "memory_on"
    memory_off = tmp_path / "memory_off"
    _write_case(memory_on, "case_1", 10, 5, 0.1)
    _write_case(memory_off, "case_1", 25, 7, 0.3)

    report = score_runs([memory_on, memory_off], tmp_path / "report.json")

    assert report["variants"]["memory_on"]["case_count"] == 1
    assert report["llm_judge_enabled"] is False
    assert "llm_judge" not in report["cases"][0]
    assert report["deltas"]["input_token_delta"] == 15
    assert report["deltas"]["output_token_delta"] == 2
    assert round(report["deltas"]["cost_delta_usd"], 6) == 0.2
    assert (tmp_path / "report.md").exists()
    markdown = (tmp_path / "report.md").read_text(encoding="utf-8")
    assert markdown.startswith("# Memory Eval 评测报告")
    assert "## 变体：memory_on" in markdown
    assert "- Case 数：1" in markdown
    assert "## 差异（memory_off - memory_on）" in markdown


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
    ]


def test_score_runs_adds_first_phase_metrics_and_avoids_reference_leakage(tmp_path):
    memory_on = tmp_path / "memory_on"
    memory_off = tmp_path / "memory_off"
    prepared = tmp_path / "prepared"
    _write_rich_case(memory_on)
    _write_rich_case(memory_off)
    _write_prepared_reference(prepared, "case_1")

    report = score_runs([memory_on, memory_off], tmp_path / "report.json", prepared_dir=prepared)

    assert report["schema_version"] == "memory_eval_scoring_v3"
    assert report["variants"]["memory_on"]["token_totals"]["cache_read_input_tokens"] == 9
    assert report["variants"]["memory_on"]["token_totals"]["new_input_output_tokens"] == 42
    assert report["variants"]["memory_on"]["token_totals"]["duration_sec"] == 4.0
    assert report["variants"]["memory_on"]["metrics"]["final_task_completion"]["mean"] == 1.0
    assert report["cases"][0]["reference"]["present"] is True
    assert report["cases"][0]["reference"]["fingerprint"].startswith("sha256:")
    assert "cache_read_input_token_delta" in report["deltas"]
    assert "duration_sec_delta" in report["deltas"]

    serialized = json.dumps(report, ensure_ascii=False)
    markdown = (tmp_path / "report.md").read_text(encoding="utf-8")
    assert "RAW_GROUND_TRUTH_SENTINEL" not in serialized
    assert "RAW_EXPECTED_APPROACH_SENTINEL" not in serialized
    assert "RAW_CRITERIA_SENTINEL" not in serialized
    assert "RAW_GROUND_TRUTH_SENTINEL" not in markdown
    assert "RAW_EXPECTED_APPROACH_SENTINEL" not in markdown
    assert "RAW_CRITERIA_SENTINEL" not in markdown


def test_score_runs_classifies_failure_profile(tmp_path):
    memory_on = tmp_path / "memory_on"
    _write_rich_case(memory_on, permission_denials=[{"tool": "Bash"}], exit_code=1)

    report = score_runs([memory_on], tmp_path / "report.json")

    profile = report["variants"]["memory_on"]["failure_profile"]
    assert profile["by_reason"]["no_result_event"] == 1
    assert profile["by_reason"]["nonzero_exit"] == 1
    assert profile["by_reason"]["is_error_flag"] == 1
    assert profile["by_reason"]["permission_denied"] == 1
    assert report["variants"]["memory_on"]["metrics"]["final_task_completion"]["fail_count"] == 1


def test_memory_specific_metrics_are_not_applicable_for_memory_off(tmp_path):
    memory_off = tmp_path / "memory_off"
    _write_rich_case(memory_off)

    report = score_runs([memory_off], tmp_path / "report.json")

    case_metrics = report["cases"][0]["metrics"]
    assert case_metrics["memory_write_quality"]["status"] == "not_applicable"
    assert case_metrics["memory_usage_evidence"]["status"] == "not_applicable"
    assert report["variants"]["memory_off"]["metrics"]["memory_write_quality"]["mean"] is None


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


def test_score_runs_can_add_llm_judge_metrics_without_leaking_reference(tmp_path):
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
            "scores": {
                "task_completion": 0.9,
                "fix_correctness": 0.8,
                "output_quality": 0.7,
                "overall": 0.8,
            },
            "rationale": "The implementation appears to satisfy the visible requirements.",
            "evidence": ["Final diff is consistent with the intended change."],
        },
    )

    report = score_runs(
        [memory_on, memory_off],
        tmp_path / "report.json",
        prepared_dir=prepared,
        llm_judge={"enabled": True, "command": [str(judge)], "timeout_sec": 30, "max_chars": 8000},
    )

    assert report["llm_judge_enabled"] is True
    assert report["cases"][0]["llm_judge"]["status"] == "pass"
    assert report["variants"]["memory_on"]["llm_metrics"]["overall"]["mean"] == 0.8
    assert report["deltas"]["llm_overall_delta"] == 0.0
    serialized = json.dumps(report, ensure_ascii=False)
    markdown = (tmp_path / "report.md").read_text(encoding="utf-8")
    assert "RAW_GROUND_TRUTH_SENTINEL" not in serialized
    assert "RAW_EXPECTED_APPROACH_SENTINEL" not in serialized
    assert "RAW_CRITERIA_SENTINEL" not in serialized
    assert "RAW_GROUND_TRUTH_SENTINEL" not in markdown


def test_score_runs_records_llm_judge_errors_without_failing(tmp_path):
    memory_on = tmp_path / "memory_on"
    prepared = tmp_path / "prepared"
    _write_rich_case(memory_on)
    _write_prepared_reference(prepared, "case_1")
    judge = tmp_path / "judge.py"
    _write_fake_judge(judge, {"not_scores": True}, exit_code=1)

    report = score_runs(
        [memory_on],
        tmp_path / "report.json",
        prepared_dir=prepared,
        llm_judge={"enabled": True, "command": [str(judge)], "timeout_sec": 30, "max_chars": 8000},
    )

    judge_result = report["cases"][0]["llm_judge"]
    assert judge_result["status"] == "judge_error"
    assert judge_result["error"] == "judge command exited with code 1"
    assert report["variants"]["memory_on"]["llm_metrics"]["judge_error_count"] == 1
