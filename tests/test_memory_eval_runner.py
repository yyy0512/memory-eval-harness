import json
import textwrap

from locobench.memory_eval.runner import build_agent_command, extract_final_result, make_session_env


def test_build_agent_command_uses_auto_memory_directory(tmp_path):
    cmd = build_agent_command("codeagentcli", "on", tmp_path / "memory")

    assert cmd[:8] == [
        "codeagentcli",
        "--dangerously-skip-permissions",
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    assert "--settings" in cmd
    settings = json.loads(cmd[cmd.index("--settings") + 1])
    assert settings["autoMemoryDirectory"] == str(tmp_path / "memory")


def test_build_agent_command_disables_memory_for_off_mode(tmp_path):
    cmd = build_agent_command("codeagentcli", "off", tmp_path / "memory")

    settings = json.loads(cmd[cmd.index("--settings") + 1])
    assert settings == {"autoMemoryEnabled": False}

def test_make_session_env_preserves_codeagent_global_config(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEAGENT3_CONFIG_DIR", "/home/user/.cac")
    monkeypatch.setenv("CODEAGENT3_SERVER_CONFIG_ISOLATION", "1")

    env = make_session_env(tmp_path / "harness")

    assert env["HOME"] == str(tmp_path / "harness" / "home")
    assert env["CODEAGENT3_CONFIG_DIR"] == "/home/user/.cac"
    assert "CODEAGENT3_SERVER_CONFIG_ISOLATION" not in env


def test_extract_final_result_returns_last_result_line(tmp_path):
    log = tmp_path / "stream.jsonl"
    log.write_text(
        json.dumps({"type": "result", "subtype": "first"})
        + "\n"
        + json.dumps({"type": "assistant", "message": "ignored"})
        + "\n"
        + json.dumps({"type": "result", "subtype": "success", "usage": {"input_tokens": 1}})
        + "\n",
        encoding="utf-8",
    )

    result = extract_final_result(log)

    assert result["subtype"] == "success"
    assert result["usage"]["input_tokens"] == 1


def test_run_batch_respects_limit_and_writes_summary(tmp_path, monkeypatch):
    from locobench.memory_eval import runner
    from locobench.memory_eval.io import write_jsonl
    from locobench.memory_eval.schema import SessionRunResult

    project = tmp_path / "project"
    project.mkdir()
    (project / "project_metadata.json").write_text("{}", encoding="utf-8")
    prepared = tmp_path / "prepared"
    case_dir = prepared / "cases" / "scenario_1"
    (case_dir / "turns").mkdir(parents=True)
    write_jsonl(case_dir / "turns" / "session_1.jsonl", [{"type": "user", "message": "hi"}])
    write_jsonl(
        prepared / "manifest.jsonl",
        [
            {
                "scenario_id": "scenario_1",
                "case_id": "case_1",
                "project_source": str(project),
                "turns": [{"session": 1, "file": "turns/session_1.jsonl", "turn_count": 1}],
            }
        ],
    )

    def fake_run_session(*args, **kwargs):
        return SessionRunResult(
            session=1,
            turns_file="turns/session_1.jsonl",
            turn_count=1,
            exit_code=0,
            duration_sec=0.1,
            stdout="logs/session_1.stream.jsonl",
            stderr="logs/session_1.stderr",
            stream_json_log="logs/session_1.stream.jsonl",
            cli_result_json="logs/session_1.result.json",
            subtype="success",
            is_error=False,
            session_id="abc",
            num_turns=1,
            stop_reason="end_turn",
            total_cost_usd=0.0,
            usage={},
            modelUsage={},
        )

    monkeypatch.setattr(runner, "run_session", fake_run_session)
    summary = runner.run_batch(prepared, "fake-agent", "off", tmp_path / "run", limit=1)

    assert summary["case_count"] == 1
    assert summary["completed_cases"] == 1
    assert (tmp_path / "run" / "run_summary.json").exists()
    assert (tmp_path / "run" / "case_1" / "harness" / "result.json").exists()


def test_run_batch_reports_progress(tmp_path, monkeypatch):
    from locobench.memory_eval import runner
    from locobench.memory_eval.io import write_jsonl
    from locobench.memory_eval.schema import SessionRunResult

    project = tmp_path / "project"
    project.mkdir()
    (project / "project_metadata.json").write_text("{}", encoding="utf-8")
    prepared = tmp_path / "prepared"
    case_dir = prepared / "cases" / "scenario_1"
    (case_dir / "turns").mkdir(parents=True)
    write_jsonl(case_dir / "turns" / "session_1.jsonl", [{"type": "user", "message": "hi"}])
    write_jsonl(
        prepared / "manifest.jsonl",
        [
            {
                "scenario_id": "scenario_1",
                "case_id": "case_1",
                "project_source": str(project),
                "turns": [{"session": 1, "file": "turns/session_1.jsonl", "turn_count": 1}],
            }
        ],
    )

    def fake_run_session(*args, **kwargs):
        return SessionRunResult(
            session=1,
            turns_file="turns/session_1.jsonl",
            turn_count=1,
            exit_code=0,
            duration_sec=0.1,
            stdout="logs/session_1.stream.jsonl",
            stderr="logs/session_1.stderr",
            stream_json_log="logs/session_1.stream.jsonl",
            cli_result_json="logs/session_1.result.json",
            subtype="success",
            is_error=False,
            session_id="abc",
            num_turns=1,
            stop_reason="end_turn",
            total_cost_usd=0.0,
            usage={},
            modelUsage={},
        )

    messages = []
    monkeypatch.setattr(runner, "run_session", fake_run_session)

    runner.run_batch(prepared, "fake-agent", "off", tmp_path / "run", limit=1, progress=messages.append)

    assert messages == [
        "Starting batch: 1 case(s), memory_mode=off",
        "Starting case 1/1: scenario_1 (1 session(s))",
        "Starting session 1 for scenario_1",
        "Finished session 1 for scenario_1: success in 0.1s",
        "Finished case 1/1: scenario_1 status=completed",
        "Run summary: completed=1 failed=0 skipped=0 total=1",
    ]


def test_smoke_summary_fails_when_permissions_were_denied(tmp_path, monkeypatch):
    from locobench.memory_eval import runner
    from locobench.memory_eval.io import write_jsonl
    from locobench.memory_eval.schema import SessionRunResult

    project = tmp_path / "project"
    project.mkdir()
    (project / "project_metadata.json").write_text("{}", encoding="utf-8")
    prepared = tmp_path / "prepared"
    case_dir = prepared / "cases" / "scenario_1"
    (case_dir / "turns").mkdir(parents=True)
    write_jsonl(case_dir / "turns" / "session_1.jsonl", [{"type": "user", "message": "hi"}])
    write_jsonl(
        prepared / "manifest.jsonl",
        [
            {
                "scenario_id": "scenario_1",
                "case_id": "case_1",
                "project_source": str(project),
                "turns": [{"session": 1, "file": "turns/session_1.jsonl", "turn_count": 1}],
            }
        ],
    )

    def fake_run_session(*args, **kwargs):
        return SessionRunResult(
            session=1,
            turns_file="turns/session_1.jsonl",
            turn_count=1,
            exit_code=0,
            duration_sec=0.1,
            stdout="logs/session_1.stream.jsonl",
            stderr="logs/session_1.stderr",
            stream_json_log="logs/session_1.stream.jsonl",
            cli_result_json="logs/session_1.result.json",
            subtype="success",
            is_error=False,
            session_id="abc",
            num_turns=1,
            stop_reason="end_turn",
            total_cost_usd=0.0,
            usage={"input_tokens": 1},
            modelUsage={"gpt-5.5": {"inputTokens": 1}},
            permission_denials=[{"tool_name": "Edit"}],
        )

    monkeypatch.setattr(runner, "run_session", fake_run_session)

    summary = runner.run_smoke(prepared, "fake-agent", None, 1, "on", tmp_path / "run")

    assert summary["status"] == "fail"
    assert summary["permission_denials_count"] == 1


def test_run_session_streams_turns_through_pipe(tmp_path):
    from locobench.memory_eval import runner
    from locobench.memory_eval.io import write_jsonl

    project = tmp_path / "project"
    project.mkdir()
    (project / "project_metadata.json").write_text("{}", encoding="utf-8")
    prepared = tmp_path / "prepared"
    case_dir = prepared / "cases" / "scenario_1"
    (case_dir / "turns").mkdir(parents=True)
    write_jsonl(
        case_dir / "turns" / "session_1.jsonl",
        [{"type": "user", "message": {"role": "user", "content": "hi"}, "parent_tool_use_id": None}],
    )
    case = {
        "scenario_id": "scenario_1",
        "case_id": "case_1",
        "project_source": str(project),
    }
    paths = runner.setup_workspace_at(case, tmp_path / "run")
    fake_agent = tmp_path / "fake_pipe_sensitive_agent.py"
    fake_agent.write_text(
        textwrap.dedent(
            """
            #!/usr/bin/env python3
            import json
            import os
            import sys

            if os.fstat(0).st_mode & 0o170000 != 0o010000:
                sys.exit(0)
            for line in sys.stdin:
                if line.strip():
                    json.loads(line)
            print(json.dumps({"type": "result", "subtype": "success", "is_error": False}))
            """
        ).lstrip(),
        encoding="utf-8",
    )
    fake_agent.chmod(0o755)

    result = runner.run_session(
        prepared,
        case,
        paths,
        {"session": 1, "file": "turns/session_1.jsonl", "turn_count": 1},
        str(fake_agent),
        "bare",
        10,
    )

    assert result.exit_code == 0
    assert result.is_error is False
    assert result.subtype == "success"
