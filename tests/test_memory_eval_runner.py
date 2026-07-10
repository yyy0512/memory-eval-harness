import json
import textwrap
import types

from locobench.memory_eval.io import write_json

from locobench.memory_eval.runner import (
    _acquire_output_lock,
    _validate_case_output_isolation,
    build_agent_command,
    build_openviking_identity,
    extract_final_result,
    make_session_env,
    variant_for_memory_mode,
)


def test_explicit_memory_mode_aliases_keep_stable_variant_names():
    assert variant_for_memory_mode("memory_off") == "memory_off"
    assert variant_for_memory_mode("memory_on") == "memory_on"
    assert variant_for_memory_mode("native_memory_on") == "native_memory_on"


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

def test_make_session_env_isolates_config_and_seeds_runtime_copy(monkeypatch, tmp_path):
    host_home = tmp_path / "host_home"
    host_home.mkdir()
    (host_home / ".cac.json").write_text('{"provider":"test"}\n', encoding="utf-8")
    host_config = host_home / ".cac"
    host_config.mkdir()
    (host_config / "settings.json").write_text('{"enterprise":{"provider":"test"}}\n', encoding="utf-8")
    monkeypatch.setenv("HOME", str(host_home))
    monkeypatch.delenv("CODEAGENT3_CONFIG_DIR", raising=False)
    monkeypatch.delenv("CODEAGENT3_SERVER_CONFIG_ISOLATION", raising=False)

    env = make_session_env(tmp_path / "harness")

    assert env["HOME"] == str(tmp_path / "harness" / "home")
    assert env["CODEAGENT3_CONFIG_DIR"] == str(tmp_path / "harness" / "codeagent_config")
    assert env["CODEAGENT3_SERVER_CONFIG_ISOLATION"] == "1"
    assert (tmp_path / "harness" / "codeagent_config" / ".cac.json").read_text(encoding="utf-8") == '{"provider":"test"}\n'
    assert (tmp_path / "harness" / "codeagent_config" / "settings.json").read_text(encoding="utf-8") == '{"enterprise":{"provider":"test"}}\n'


def test_openviking_identity_is_scoped_by_run_variant_and_case():
    identity = build_openviking_identity(
        "openviking_on",
        {"case_id": "case_1"},
        run_namespace="run-abc",
    )

    assert identity["run_namespace"] == "run-abc"
    assert "run-abc-openviking_on-case_1" in identity["user"]
    assert "run-abc-openviking_on-case_1" in identity["peer_id"]


def test_output_lock_rejects_parallel_writers(tmp_path):
    first = _acquire_output_lock(tmp_path / "run")
    try:
        try:
            _acquire_output_lock(tmp_path / "run")
        except RuntimeError as exc:
            assert "already using output directory" in str(exc)
        else:
            raise AssertionError("second writer unexpectedly acquired the same output lock")
    finally:
        first.close()


def test_setup_workspace_clears_stale_case_memory_and_harness(tmp_path):
    from locobench.memory_eval import runner

    project = tmp_path / "project"
    project.mkdir()
    (project / "source.txt").write_text("clean\n", encoding="utf-8")
    case_root = tmp_path / "run" / "case_1"
    stale_memory = case_root / "agent_root" / "memory"
    stale_harness = case_root / "harness"
    stale_memory.mkdir(parents=True)
    stale_harness.mkdir(parents=True)
    (stale_memory / "old.md").write_text("stale memory\n", encoding="utf-8")
    (stale_harness / "old.log").write_text("stale harness\n", encoding="utf-8")

    paths = runner.setup_workspace_at(
        {"case_id": "case_1", "scenario_id": "scenario_1", "project_source": str(project)},
        case_root,
    )

    assert not (paths["memory"] / "old.md").exists()
    assert not (paths["harness"] / "old.log").exists()
    assert (paths["workspace"] / "source.txt").read_text(encoding="utf-8") == "clean\n"


def test_case_id_collision_is_rejected_before_workspaces_can_mix(tmp_path):
    cases = [
        {"case_id": "same", "scenario_id": "scenario_a"},
        {"case_id": "same", "scenario_id": "scenario_b"},
    ]

    try:
        _validate_case_output_isolation(cases, tmp_path / "run", resume=False)
    except ValueError as exc:
        assert "case_id collision" in str(exc)
    else:
        raise AssertionError("case path collision was not rejected")


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
    metadata = json.loads((tmp_path / "run" / ".memory_eval_run.json").read_text(encoding="utf-8"))
    assert metadata["run_namespace"] == summary["run_namespace"]
    result_path = tmp_path / "run" / "case_1" / "harness" / "result.json"
    assert result_path.exists()
    result = json.loads(result_path.read_text(encoding="utf-8"))
    assert result["prepared_snapshot"] == "prepared_snapshot/case"
    assert result["prepared_provenance"] == "prepared_snapshot/provenance.json"
    provenance = json.loads(
        (tmp_path / "run" / "case_1" / "harness" / "prepared_snapshot" / "provenance.json").read_text(
            encoding="utf-8"
        )
    )
    assert provenance["verification_status"] == "legacy_computed_verified"


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


def test_run_batch_settles_between_native_memory_sessions(tmp_path, monkeypatch):
    from locobench.memory_eval import runner
    from locobench.memory_eval.io import read_json, write_jsonl
    from locobench.memory_eval.schema import SessionRunResult

    project = tmp_path / "project"
    project.mkdir()
    (project / "project_metadata.json").write_text("{}", encoding="utf-8")
    prepared = tmp_path / "prepared"
    case_dir = prepared / "cases" / "scenario_1"
    (case_dir / "turns").mkdir(parents=True)
    write_jsonl(case_dir / "turns" / "session_1.jsonl", [{"type": "user", "message": "s1"}])
    write_jsonl(case_dir / "turns" / "session_2.jsonl", [{"type": "user", "message": "s2"}])
    write_jsonl(
        prepared / "manifest.jsonl",
        [
            {
                "scenario_id": "scenario_1",
                "case_id": "case_1",
                "project_source": str(project),
                "turns": [
                    {"session": 1, "file": "turns/session_1.jsonl", "turn_count": 1},
                    {"session": 2, "file": "turns/session_2.jsonl", "turn_count": 1},
                ],
            }
        ],
    )

    def fake_run_session(*args, **kwargs):
        turn = args[3]
        session = int(turn["session"])
        return SessionRunResult(
            session=session,
            turns_file=turn["file"],
            turn_count=1,
            exit_code=0,
            duration_sec=0.1,
            stdout=f"logs/session_{session}.stream.jsonl",
            stderr=f"logs/session_{session}.stderr",
            stream_json_log=f"logs/session_{session}.stream.jsonl",
            cli_result_json=f"logs/session_{session}.result.json",
            subtype="success",
            is_error=False,
            session_id=f"session-{session}",
            num_turns=1,
            stop_reason="end_turn",
            total_cost_usd=0.0,
            usage={},
            modelUsage={},
        )

    settle_calls = []

    def fake_settle(memory_mode, memory_settle_sec):
        settle_calls.append((memory_mode, memory_settle_sec))
        return {
            "enabled": True,
            "memory_mode": memory_mode,
            "memory_backend": "native",
            "strategy": "fixed_sleep",
            "requested_sec": memory_settle_sec,
            "duration_sec": memory_settle_sec,
            "status": "completed",
        }

    monkeypatch.setattr(runner, "run_session", fake_run_session)
    monkeypatch.setattr(runner, "settle_memory_between_sessions", fake_settle)

    summary = runner.run_batch(prepared, "fake-agent", "native_memory_on", tmp_path / "run", memory_settle_sec=10)

    assert summary["memory_settle_sec"] == 10
    assert settle_calls == [("native_memory_on", 10)]
    result = read_json(tmp_path / "run" / "case_1" / "harness" / "result.json")
    assert result["run_environment"]["memory_settle_sec"] == 10
    assert result["sessions"][0]["memory_settle"]["status"] == "completed"
    assert result["sessions"][0]["memory_settle"]["requested_sec"] == 10
    assert result["sessions"][1]["memory_settle"] is None


def test_run_batch_does_not_settle_memory_off_sessions(tmp_path, monkeypatch):
    from locobench.memory_eval import runner
    from locobench.memory_eval.io import read_json, write_jsonl
    from locobench.memory_eval.schema import SessionRunResult

    project = tmp_path / "project"
    project.mkdir()
    (project / "project_metadata.json").write_text("{}", encoding="utf-8")
    prepared = tmp_path / "prepared"
    case_dir = prepared / "cases" / "scenario_1"
    (case_dir / "turns").mkdir(parents=True)
    write_jsonl(case_dir / "turns" / "session_1.jsonl", [{"type": "user", "message": "s1"}])
    write_jsonl(case_dir / "turns" / "session_2.jsonl", [{"type": "user", "message": "s2"}])
    write_jsonl(
        prepared / "manifest.jsonl",
        [
            {
                "scenario_id": "scenario_1",
                "case_id": "case_1",
                "project_source": str(project),
                "turns": [
                    {"session": 1, "file": "turns/session_1.jsonl", "turn_count": 1},
                    {"session": 2, "file": "turns/session_2.jsonl", "turn_count": 1},
                ],
            }
        ],
    )

    def fake_run_session(*args, **kwargs):
        turn = args[3]
        session = int(turn["session"])
        return SessionRunResult(
            session=session,
            turns_file=turn["file"],
            turn_count=1,
            exit_code=0,
            duration_sec=0.1,
            stdout=f"logs/session_{session}.stream.jsonl",
            stderr=f"logs/session_{session}.stderr",
            stream_json_log=f"logs/session_{session}.stream.jsonl",
            cli_result_json=f"logs/session_{session}.result.json",
            subtype="success",
            is_error=False,
            session_id=f"session-{session}",
            num_turns=1,
            stop_reason="end_turn",
            total_cost_usd=0.0,
            usage={},
            modelUsage={},
        )

    monkeypatch.setattr(runner, "run_session", fake_run_session)
    monkeypatch.setattr(runner, "settle_memory_between_sessions", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not settle")))

    runner.run_batch(prepared, "fake-agent", "memory_off", tmp_path / "run", memory_settle_sec=10)

    result = read_json(tmp_path / "run" / "case_1" / "harness" / "result.json")
    assert result["run_environment"]["memory_settle_sec"] == 10
    assert result["sessions"][0]["memory_settle"] is None
    assert result["sessions"][1]["memory_settle"] is None


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


def _session_ok():
    return types.SimpleNamespace(is_error=False)


def _post_run_paths(tmp_path):
    workspace = tmp_path / "case" / "agent_root" / "workspace"
    harness = tmp_path / "case" / "harness"
    workspace.mkdir(parents=True)
    (harness / "logs").mkdir(parents=True)
    return {"workspace": workspace, "harness": harness}


def _post_run_prepared(tmp_path, test_plan):
    prepared = tmp_path / "prepared_post_run"
    write_json(
        prepared / "cases" / "scenario_1" / "scoring_reference.json",
        {"scenario_id": "scenario_1", "test_plan": test_plan},
    )
    return prepared


def test_docker_preflight_command_checks_go_image_tools():
    from locobench.memory_eval.runner import _docker_preflight_command

    command_text = " ".join(_docker_preflight_command("locobench-memory-eval:go", "none"))

    for tool in ("go", "node", "npm", "jest", "vitest", "mocha", "cross-env", "make", "git", "bash"):
        assert f" {tool} " in f" {command_text} "


def test_classify_test_failure_detects_missing_header():
    from locobench.memory_eval.runner import _classify_test_failure

    result = _classify_test_failure(
        "",
        "src/main.c:24:10: fatal error: microhttpd.h: No such file or directory\ncompilation terminated.",
        2,
        "host",
    )

    assert result["environment_status"] == "missing_system_dependency"
    assert result["failure_classification"] == "missing_system_dependency"
    assert result["missing_dependency"] == "microhttpd.h"


def test_classify_test_failure_detects_go_module_network_failure():
    from locobench.memory_eval.runner import _classify_test_failure

    result = _classify_test_failure(
        "go: downloading github.com/gin-gonic/gin v1.9.1\n",
        "go: github.com/gin-gonic/gin@v1.9.1: Get \"https://proxy.golang.org/github.com/gin-gonic/gin/@v/v1.9.1.mod\": dial tcp: lookup proxy.golang.org: no such host\n",
        1,
        "docker",
    )

    assert result["environment_status"] == "missing_system_dependency"
    assert result["failure_classification"] == "network_dependency_unavailable"
    assert result["missing_dependency"] == "network_fetch_dependency"


def test_classify_test_failure_detects_npm_network_failure():
    from locobench.memory_eval.runner import _classify_test_failure

    result = _classify_test_failure(
        "",
        "npm ERR! network request to https://registry.npmjs.org/jest failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org\n",
        1,
        "docker",
    )

    assert result["environment_status"] == "missing_system_dependency"
    assert result["failure_classification"] == "network_dependency_unavailable"
    assert result["missing_dependency"] == "network_fetch_dependency"


def test_classify_test_failure_keeps_go_compile_errors_as_test_failed():
    from locobench.memory_eval.runner import _classify_test_failure

    result = _classify_test_failure(
        "",
        "# example.com/service\n./main.go:42:13: undefined: RateLimiter\n./main.go:43:9: declared and not used: cfg\n",
        1,
        "docker",
    )

    assert result["environment_status"] == "ready"
    assert result["failure_classification"] == "test_failed"



    result = _classify_test_failure(
        "> @mercury/monolith@1.4.2 test\n> jest --runInBand\nNo tests found, exiting with code 1\n",
        "",
        1,
        "docker",
    )

    assert result["environment_status"] == "not_configured"
    assert result["failure_classification"] == "test_plan_no_tests_found"


def test_classify_test_failure_treats_missing_cmake_fixture_files_as_not_configured():
    from locobench.memory_eval.runner import _classify_test_failure

    result = _classify_test_failure(
        "",
        'CMake Error at CMakeLists.txt:148 (add_subdirectory):\n  add_subdirectory given source "test" which is not an existing directory.\nCMake Error: File /workspace/chronoflow_fabric/docs/Doxyfile.in does not exist.\n',
        1,
        "docker",
    )

    assert result["environment_status"] == "not_configured"
    assert result["failure_classification"] == "test_plan_missing_project_files"


def test_classify_test_failure_treats_markdown_fenced_cmake_fixture_as_not_configured():
    from locobench.memory_eval.runner import _classify_test_failure

    result = _classify_test_failure(
        "",
        'CMake Error at CMakeLists.txt:1:\n  Parse error. Expected a command name, got unquoted argument with text\n  "```".\n',
        127,
        "docker",
    )

    assert result["environment_status"] == "not_configured"
    assert result["failure_classification"] == "malformed_test_fixture"


def test_classify_test_failure_marks_pure_libmicrohttpd_api_mismatch_as_dependency_issue():
    from locobench.memory_eval.runner import _classify_test_failure

    result = _classify_test_failure(
        "",
        "src/main.c:401:42: error: 'MHD_QUEUE' undeclared\nsrc/main.c:479:9: error: 'MHD_USE_SIGNAL_PIPE' undeclared\n/usr/include/microhttpd.h:2701:45: note: expected 'MHD_AccessHandlerCallback'\n",
        2,
        "docker",
    )

    assert result["environment_status"] == "missing_system_dependency"
    assert result["failure_classification"] == "incompatible_system_dependency"
    assert result["missing_dependency"] == "libmicrohttpd_api"


def test_classify_test_failure_keeps_mixed_generated_code_errors_as_test_failed():
    from locobench.memory_eval.runner import _classify_test_failure

    result = _classify_test_failure(
        "",
        "src/main.c:274:13: error: 'LOG_LEVEL_WARN' undeclared\nsrc/main.c:361:9: error: passing argument 5 of 'MHD_start_daemon' from incompatible pointer type\n",
        2,
        "docker",
    )

    assert result["environment_status"] == "ready"
    assert result["failure_classification"] == "test_failed"


def test_run_post_run_tests_marks_narrowed_makefile_as_invalid(tmp_path):
    from locobench.memory_eval.runner import run_post_run_tests

    paths = _post_run_paths(tmp_path)
    (paths["workspace"] / "Makefile").write_text("test: test-rate-limiter\n\t@echo narrowed\n", encoding="utf-8")
    (paths["workspace"] / "tests").mkdir()
    (paths["workspace"] / "tests" / "test_router.c").write_text("int main(void) { return 0; }\n", encoding="utf-8")
    prepared = _post_run_prepared(
        tmp_path,
        {
            "status": "configured",
            "command": ["python3", "-c", "print('ok')"],
            "working_dir": ".",
            "source": "makefile_test_target",
            "timeout_sec": 30,
            "integrity": {
                "status": "checkable",
                "original_test_files": ["tests/test_router.c"],
                "required_patterns": ["$(TEST_BIN)", "test_router.c"],
                "makefile_path": "Makefile",
            },
        },
    )

    result = run_post_run_tests(
        prepared,
        {"scenario_id": "scenario_1", "case_id": "case_1"},
        paths,
        [_session_ok()],
    )

    assert result["status"] == "invalid"
    assert result["environment_status"] == "ready"
    assert result["integrity_status"] == "failed"
    assert result["integrity_reason"] == "original_test_runner_removed_or_narrowed"


def test_run_post_run_tests_classifies_docker_unavailable(tmp_path, monkeypatch):
    from locobench.memory_eval import runner

    paths = _post_run_paths(tmp_path)
    prepared = _post_run_prepared(
        tmp_path,
        {
            "status": "configured",
            "command": ["make", "test"],
            "working_dir": ".",
            "source": "makefile_test_target",
            "timeout_sec": 30,
            "docker_image": "locobench-memory-eval:c",
            "integrity": {"status": "not_checked"},
        },
    )

    def raise_oserror(*args, **kwargs):
        raise OSError("docker unavailable")

    monkeypatch.setattr(runner.subprocess, "run", raise_oserror)

    result = runner.run_post_run_tests(
        prepared,
        {"scenario_id": "scenario_1", "case_id": "case_1"},
        paths,
        [_session_ok()],
        test_executor="docker",
    )

    assert result["status"] == "skipped"
    assert result["executor"] == "docker"
    assert result["environment_status"] == "docker_unavailable"
    assert result["failure_classification"] == "docker_unavailable"


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
    assert result.environment_root == "session_envs/session_1"
    assert (paths["harness"] / result.environment_root / "home").is_dir()
