import json

from locobench.memory_eval.io import read_jsonl
from locobench.memory_eval.prepare import extract_case_id, prepare_dataset, split_prompt_into_sessions


def test_extract_case_id_from_multi_session_scenario_id():
    assert (
        extract_case_id("c_api_gateway_easy_009_multi_session_development_expert_01")
        == "c_api_gateway_easy_009"
    )


def test_split_prompt_into_sessions_from_markdown_headers():
    prompt = "Shared intro.\n\n**Session 1: First**\nDo A.\n\n**Session 2: Second**\nDo B."

    sessions = split_prompt_into_sessions(prompt)

    assert len(sessions) == 2
    assert "Do A." in sessions[0]
    assert "Do B." in sessions[1]
    assert "Shared intro." in sessions[0]


def test_prepare_dataset_writes_manifest_case_turns_and_reference(tmp_path):
    scenarios = tmp_path / "agent_scenarios"
    generated = tmp_path / "generated"
    project = generated / "c_api_gateway_easy_009"
    scenarios.mkdir(parents=True)
    project.mkdir(parents=True)
    (project / "project_metadata.json").write_text("{}", encoding="utf-8")
    scenario = {
        "scenario_id": "c_api_gateway_easy_009_multi_session_development_expert_01",
        "category": "extended_development_projects",
        "difficulty": "expert",
        "project_directory": str(project),
        "project_spec": {"name": "EduGate", "language": "c", "complexity": "easy"},
        "original_scenario": {
            "task_category": "multi_session_development",
            "task_prompt": "Intro.\n\n**Session 1: First**\nDo A.\n\n**Session 2: Second**\nDo B.",
            "ground_truth": "ideal",
            "expected_approach": "steps",
            "evaluation_criteria": ["criterion"],
        },
    }
    (scenarios / "c_api_gateway_easy_009_multi_session_development_expert_01.json").write_text(
        json.dumps(scenario), encoding="utf-8"
    )

    output = tmp_path / "prepared"
    summary = prepare_dataset(scenarios, generated, output, limit=1)

    assert summary["case_count"] == 1
    manifest = read_jsonl(output / "manifest.jsonl")
    assert manifest[0]["session_count"] == 2
    turn_rows = read_jsonl(output / "cases" / manifest[0]["scenario_id"] / "turns" / "session_2.jsonl")
    assert turn_rows[0]["type"] == "user"
    assert turn_rows[0]["parent_tool_use_id"] is None
    assert turn_rows[0]["message"]["role"] == "user"
    assert "conversation context is unavailable" in turn_rows[0]["message"]["content"]
    reference = json.loads((output / "cases" / manifest[0]["scenario_id"] / "scoring_reference.json").read_text())
    assert reference["ground_truth"] == "ideal"


def test_prepare_dataset_skips_scenarios_without_session_prompts(tmp_path):
    scenarios = tmp_path / "agent_scenarios"
    generated = tmp_path / "generated"
    scenarios.mkdir(parents=True)

    bad_project = generated / "c_aaa_dashboard_medium_003"
    good_project = generated / "c_api_gateway_easy_009"
    bad_project.mkdir(parents=True)
    good_project.mkdir(parents=True)

    bad_scenario_id = "c_aaa_dashboard_medium_003_multi_session_development_easy_01"
    good_scenario_id = "c_api_gateway_easy_009_multi_session_development_expert_01"
    (scenarios / f"{bad_scenario_id}.json").write_text(
        json.dumps(
            {
                "scenario_id": bad_scenario_id,
                "category": "extended_development_projects",
                "project_directory": str(bad_project),
                "original_scenario": {"task_category": "multi_session_development", "task_prompt": ""},
            }
        ),
        encoding="utf-8",
    )
    (scenarios / f"{good_scenario_id}.json").write_text(
        json.dumps(
            {
                "scenario_id": good_scenario_id,
                "category": "extended_development_projects",
                "project_directory": str(good_project),
                "original_scenario": {
                    "task_category": "multi_session_development",
                    "task_prompt": "**Session 1**\nDo A.",
                },
            }
        ),
        encoding="utf-8",
    )

    output = tmp_path / "prepared"
    summary = prepare_dataset(scenarios, generated, output, limit=1)

    assert summary["case_count"] == 1
    assert summary["cases"] == [good_scenario_id]
    assert not (output / "cases" / bad_scenario_id).exists()
