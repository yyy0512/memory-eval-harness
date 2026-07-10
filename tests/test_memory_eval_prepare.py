import json

import pytest

from locobench.memory_eval.io import read_jsonl, sha256_prepared_case, sha256_prepared_dataset
from locobench.memory_eval.prepare import build_turn_message, extract_case_id, prepare_dataset, split_prompt_into_sessions


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
    assert summary["dataset_stats"]["difficulty_distribution"] == {"expert": 1}
    assert summary["dataset_stats"]["task_type_distribution"] == {"multi_session_development": 1}
    assert summary["dataset_stats"]["programming_language_distribution"] == {"c": 1}
    assert summary["dataset_stats"]["contract_stats"] == {
        "contracts_per_case_distribution": {"0": 1},
        "contract_id_distribution": {},
        "contract_category_distribution": {},
        "contract_memory_type_distribution": {},
        "workspace_checkable_contracts_per_case_distribution": {"0": 1},
        "memory_fact_contracts_per_case_distribution": {"0": 1},
        "case_contracts": [
            {
                "scenario_id": "c_api_gateway_easy_009_multi_session_development_expert_01",
                "case_id": "c_api_gateway_easy_009",
                "contract_count": 0,
                "memory_fact_contract_count": 0,
                "workspace_checkable_contract_count": 0,
                "contract_ids": [],
                "memory_fact_contract_ids": [],
                "workspace_checkable_contract_ids": [],
                "contract_categories": [],
                "memory_types": [],
            }
        ],
    }
    assert summary["dataset_stats"]["test_availability_stats"] == {"without_test_like_files": 1}
    assert summary["dataset_stats"]["test_plan_stats"] == {"no_tests": 1}
    assert summary["dataset_stats"]["requirement_check_stats"]["checks_per_case_distribution"] == {"0": 1}
    assert summary["dataset_stats"]["requirement_check_stats"]["configured_cases"] == 0
    assert summary["dataset_stats"]["requirement_check_stats"]["not_configured_cases"] == 1
    manifest = read_jsonl(output / "manifest.jsonl")
    assert manifest[0]["session_count"] == 2
    turn_rows = read_jsonl(output / "cases" / manifest[0]["scenario_id"] / "turns" / "session_2.jsonl")
    assert turn_rows[0]["type"] == "user"
    assert turn_rows[0]["parent_tool_use_id"] is None
    assert turn_rows[0]["message"]["role"] == "user"
    assert "conversation context is unavailable" in turn_rows[0]["message"]["content"]
    reference = json.loads((output / "cases" / manifest[0]["scenario_id"] / "scoring_reference.json").read_text())
    assert reference["ground_truth"] == "ideal"
    case_dir = output / "cases" / manifest[0]["scenario_id"]
    assert manifest[0]["hashes"]["prepared_case_sha256"] == sha256_prepared_case(case_dir)
    assert summary["prepared_dataset_sha256"] == sha256_prepared_dataset(output)
    assert summary["schema_version"] == "memory_eval_prepared_v2_immutable"

    with pytest.raises(FileExistsError, match="immutable"):
        prepare_dataset(scenarios, generated, output, limit=1)


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
    assert summary["dataset_stats"]["difficulty_distribution"] == {"unknown": 1}
    assert summary["dataset_stats"]["task_type_distribution"] == {"multi_session_development": 1}
    assert summary["dataset_stats"]["programming_language_distribution"] == {"unknown": 1}
    assert summary["dataset_stats"]["contract_stats"]["contracts_per_case_distribution"] == {"0": 1}
    assert summary["dataset_stats"]["test_availability_stats"] == {"without_test_like_files": 1}
    assert summary["cases"] == [good_scenario_id]
    assert not (output / "cases" / bad_scenario_id).exists()

def test_build_turn_message_does_not_inject_contracts_into_main_session_prompt():
    message = build_turn_message(
        1,
        2,
        "Do A.",
    )

    assert "continuity contracts" not in message
    assert "memory handoff for later sessions" not in message
    assert "Memory-eval notes to save for future sessions" not in message
    assert "Project memory" not in message
    assert "Do A." in message


def test_prepare_dataset_can_apply_contract_overlay_without_changing_source_scenario(tmp_path):
    scenarios = tmp_path / "agent_scenarios"
    generated = tmp_path / "generated"
    project = generated / "c_api_gateway_easy_009"
    scenarios.mkdir(parents=True)
    project.mkdir(parents=True)
    scenario_id = "c_api_gateway_easy_009_multi_session_development_expert_01"
    scenario = {
        "scenario_id": scenario_id,
        "category": "extended_development_projects",
        "project_directory": str(project),
        "original_scenario": {
            "task_category": "multi_session_development",
            "task_prompt": "Intro.\n\n**Session 1: First**\nDo A.\n\n**Session 2: Second**\nDo B.",
        },
    }
    scenario_path = scenarios / f"{scenario_id}.json"
    scenario_path.write_text(json.dumps(scenario), encoding="utf-8")
    original_scenario_text = scenario_path.read_text(encoding="utf-8")
    overlay = tmp_path / "contracts.json"
    overlay.write_text(
        json.dumps(
            {
                "memory_contracts": [
                    {
                        "id": "api_error_envelope",
                        "introduced_in_session": 1,
                        "description": "All new API errors must use { error: { code, message } }.",
                        "checks": [
                            {
                                "type": "require_regex",
                                "path_glob": "src/**/*.ts",
                                "pattern": "error\\s*:",
                            }
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    output = tmp_path / "prepared"
    summary = prepare_dataset(scenarios, generated, output, limit=1, contract_overlay=overlay)

    assert scenario_path.read_text(encoding="utf-8") == original_scenario_text
    assert summary["memory_contract_count"] == 1
    assert summary["dataset_stats"]["contract_stats"]["contracts_per_case_distribution"] == {"1": 1}
    assert summary["dataset_stats"]["contract_stats"]["contract_id_distribution"] == {"api_error_envelope": 1}
    assert summary["dataset_stats"]["contract_stats"]["contract_category_distribution"] == {"uncategorized": 1}
    assert summary["dataset_stats"]["contract_stats"]["contract_memory_type_distribution"] == {"project": 1}
    assert summary["dataset_stats"]["contract_stats"]["workspace_checkable_contracts_per_case_distribution"] == {"1": 1}
    assert summary["dataset_stats"]["contract_stats"]["memory_fact_contracts_per_case_distribution"] == {"1": 1}
    session_1_turns = read_jsonl(output / "cases" / scenario_id / "turns" / "session_1.jsonl")
    session_1 = session_1_turns[0]["message"]["content"]
    session_1_followup = session_1_turns[1]["message"]["content"]
    session_2 = read_jsonl(output / "cases" / scenario_id / "turns" / "session_2.jsonl")[0]["message"]["content"]
    assert len(session_1_turns) == 2
    assert "All new API errors must use { error: { code, message } }." not in session_1
    assert "All new API errors must use { error: { code, message } }." in session_1_followup
    assert "Do not edit repository files in this turn" in session_1_followup
    assert "api_error_envelope" not in session_1
    assert "api_error_envelope" not in session_1_followup
    assert "api_error_envelope" not in session_2
    case_json = json.loads((output / "cases" / scenario_id / "case.json").read_text(encoding="utf-8"))
    assert case_json["turns"][0]["turn_count"] == 2
    reference = json.loads((output / "cases" / scenario_id / "scoring_reference.json").read_text())


def test_prepare_dataset_uses_scoped_requirement_overlay(tmp_path):
    scenarios = tmp_path / "agent_scenarios"
    generated = tmp_path / "generated"
    project = generated / "c_api_gateway_easy_009"
    scenarios.mkdir(parents=True)
    project.mkdir(parents=True)
    scenario_id = "c_api_gateway_easy_009_multi_session_development_expert_01"
    (scenarios / f"{scenario_id}.json").write_text(
        json.dumps(
            {
                "scenario_id": scenario_id,
                "category": "extended_development_projects",
                "project_directory": str(project),
                "project_spec": {"language": "c"},
                "original_scenario": {
                    "task_category": "multi_session_development",
                    "task_prompt": "**Session 1**\nAdd rate limiting.",
                },
            }
        ),
        encoding="utf-8",
    )
    overlay = tmp_path / "overlay.json"
    overlay.write_text(
        json.dumps(
            {
                "requirement_checks": [
                    {"id": "global_check", "type": "file_exists", "path_glob": "README.md"}
                ],
                "language_requirement_checks": {
                    "c": [{"id": "language_check", "type": "file_exists", "path_glob": "src/main.c"}]
                },
                "case_requirement_checks": {
                    "c_api_gateway_easy_009": [
                        {
                            "id": "has_rate_limiter_module",
                            "type": "file_exists",
                            "path_glob": "**/rate_limiter.c",
                            "rationale": "case-specific requirement",
                        }
                    ]
                },
            }
        ),
        encoding="utf-8",
    )

    output = tmp_path / "prepared"
    summary = prepare_dataset(scenarios, generated, output, limit=1, contract_overlay=overlay)
    reference = json.loads((output / "cases" / scenario_id / "scoring_reference.json").read_text())

    assert [check["id"] for check in reference["requirement_checks"]] == [
        "global_check",
        "language_check",
        "has_rate_limiter_module",
    ]
    assert all(check["source"] == "overlay" for check in reference["requirement_checks"])
    assert all(check["strength"] == "explicit" for check in reference["requirement_checks"])
    stats = summary["dataset_stats"]["requirement_check_stats"]
    assert stats["configured_by_overlay_cases"] == 1
    assert stats["source_distribution"] == {"overlay": 3}


def test_prepare_dataset_requires_explicit_evaluator_requirement_checks(tmp_path):
    scenarios = tmp_path / "agent_scenarios"
    generated = tmp_path / "generated"
    project = generated / "c_api_gateway_easy_009"
    scenarios.mkdir(parents=True)
    project.mkdir(parents=True)
    scenario_id = "c_api_gateway_easy_009_multi_session_development_expert_01"
    (scenarios / f"{scenario_id}.json").write_text(
        json.dumps(
            {
                "scenario_id": scenario_id,
                "category": "extended_development_projects",
                "project_directory": str(project),
                "project_spec": {"language": "c"},
                "original_scenario": {
                    "task_category": "multi_session_development",
                    "task_prompt": "**Session 1**\nAdd `RateLimiter`, return HTTP 429 with RATE_LIMIT_EXCEEDED, and update config/rate_limits.yml.",
                    "evaluation_criteria": ["Do not just build context correctly."],
                },
            }
        ),
        encoding="utf-8",
    )

    output = tmp_path / "prepared"
    summary = prepare_dataset(scenarios, generated, output, limit=1)
    reference = json.loads((output / "cases" / scenario_id / "scoring_reference.json").read_text())

    assert reference["requirement_check_plan"]["status"] == "not_configured"
    assert reference["requirement_check_plan"]["source"] == "evaluator_overlay"
    assert reference["requirement_check_plan"]["reason"] == "explicit_evaluator_checks_required"
    assert reference["requirement_checks"] == []
    assert summary["dataset_stats"]["requirement_check_stats"]["configured_by_auto_cases"] == 0


def test_prepare_dataset_does_not_generate_generic_requirement_checks(tmp_path):
    scenarios = tmp_path / "agent_scenarios"
    generated = tmp_path / "generated"
    project = generated / "c_api_gateway_easy_009"
    scenarios.mkdir(parents=True)
    project.mkdir(parents=True)
    scenario_id = "c_api_gateway_easy_009_multi_session_development_expert_01"
    (scenarios / f"{scenario_id}.json").write_text(
        json.dumps(
            {
                "scenario_id": scenario_id,
                "category": "extended_development_projects",
                "project_directory": str(project),
                "project_spec": {"language": "c"},
                "original_scenario": {
                    "task_category": "multi_session_development",
                    "task_prompt": "**Session 1**\nUse context and ensure the agent can build correctly.",
                    "evaluation_criteria": ["context", "correctly", "agent", "build"],
                },
            }
        ),
        encoding="utf-8",
    )

    output = tmp_path / "prepared"
    summary = prepare_dataset(scenarios, generated, output, limit=1)
    reference = json.loads((output / "cases" / scenario_id / "scoring_reference.json").read_text())

    assert reference["requirement_checks"] == []
    assert reference["requirement_check_plan"]["status"] == "not_configured"
    assert reference["requirement_check_plan"]["reason"] == "explicit_evaluator_checks_required"
    assert summary["dataset_stats"]["requirement_check_stats"]["checks_per_case_distribution"] == {"0": 1}


def test_prepare_dataset_selects_category_and_case_contracts_with_expected_memory_facts(tmp_path):
    scenarios = tmp_path / "agent_scenarios"
    generated = tmp_path / "generated"
    project = generated / "c_api_gateway_easy_009"
    scenarios.mkdir(parents=True)
    project.mkdir(parents=True)
    scenario_id = "c_api_gateway_easy_009_multi_session_development_expert_01"
    (scenarios / f"{scenario_id}.json").write_text(
        json.dumps(
            {
                "scenario_id": scenario_id,
                "category": "extended_development_projects",
                "project_directory": str(project),
                "project_spec": {"language": "c", "name": "EduGate"},
                "original_scenario": {
                    "task_category": "multi_session_development",
                    "task_prompt": "Intro.\n\n**Session 1: First**\nAdd student route.\n\n**Session 2: Second**\nExtend it.",
                },
            }
        ),
        encoding="utf-8",
    )
    overlay = tmp_path / "contracts.json"
    overlay.write_text(
        json.dumps(
            {
                "selection": {"max_contracts_per_case": 5},
                "memory_contracts": [
                    {
                        "id": "shared_memory_contract",
                        "category": "cross_session",
                        "introduced_in_session": 1,
                        "description": "Remember shared project decisions.",
                        "expected_memory_fact": {
                            "required_keywords": ["shared project decisions"]
                        },
                    }
                ],
                "language_contracts": {
                    "c": [
                        {
                            "id": "c_header_contract",
                            "category": "language_private",
                            "introduced_in_session": 1,
                            "description": "EduGate public C functions stay in edugate.h.",
                            "expected_memory_fact": {
                                "required_keywords": ["EduGate", "edugate.h"]
                            },
                        }
                    ]
                },
                "category_contracts": {
                    "multi_session_development": [
                        {
                            "id": "category_contract",
                            "category": "task_private",
                            "introduced_in_session": 1,
                            "description": "Later sessions must preserve first-session compatibility decisions.",
                            "expected_memory_fact": {
                                "required_keywords": ["first-session compatibility"]
                            },
                        },
                        {
                            "id": "shared_memory_contract",
                            "category": "duplicate_should_be_skipped",
                            "introduced_in_session": 1,
                            "description": "Duplicate id should not be added twice.",
                        },
                    ]
                },
                "case_contracts": {
                    "c_api_gateway_easy_009": [
                        {
                            "id": "edugate_student_route_compat",
                            "category": "case_private_compatibility",
                            "introduced_in_session": 1,
                            "description": "EduGate must keep /v1/student backward compatible and only add optional fields.",
                            "expected_memory_fact": {
                                "required_keywords": [
                                    "EduGate",
                                    "/v1/student",
                                    "backward compatible",
                                    "optional fields",
                                ]
                            },
                        }
                    ]
                },
            }
        ),
        encoding="utf-8",
    )

    output = tmp_path / "prepared"
    summary = prepare_dataset(scenarios, generated, output, limit=1, contract_overlay=overlay)
    reference = json.loads((output / "cases" / scenario_id / "scoring_reference.json").read_text())

    assert summary["dataset_stats"]["contract_stats"]["contracts_per_case_distribution"] == {"4": 1}
    assert summary["dataset_stats"]["contract_stats"]["contract_id_distribution"] == {
        "c_header_contract": 1,
        "category_contract": 1,
        "edugate_student_route_compat": 1,
        "shared_memory_contract": 1,
    }
    assert [contract["id"] for contract in reference["memory_contracts"]] == [
        "shared_memory_contract",
        "c_header_contract",
        "category_contract",
        "edugate_student_route_compat",
    ]
    assert [fact["id"] for fact in reference["expected_memory_facts"]] == [
        "shared_memory_contract",
        "c_header_contract",
        "category_contract",
        "edugate_student_route_compat",
    ]


def test_prepare_dataset_derives_expected_memory_fact_anchors_from_c_case(tmp_path):
    scenarios = tmp_path / "agent_scenarios"
    generated = tmp_path / "generated"
    project = generated / "c_api_gateway_easy_009"
    scenarios.mkdir(parents=True)
    (project / "include").mkdir(parents=True)
    (project / "config").mkdir(parents=True)
    (project / "tests").mkdir(parents=True)
    (project / "include" / "gateway.h").write_text("int gateway_route(void);\n", encoding="utf-8")
    (project / "config" / "rate_limits.yml").write_text("limit: 10\n", encoding="utf-8")
    (project / "tests" / "test_gateway.c").write_text("// tests\n", encoding="utf-8")
    scenario_id = "c_api_gateway_easy_009_multi_session_development_expert_01"
    (scenarios / f"{scenario_id}.json").write_text(
        json.dumps(
            {
                "scenario_id": scenario_id,
                "category": "extended_development_projects",
                "project_directory": str(project),
                "project_spec": {"language": "c"},
                "original_scenario": {
                    "task_category": "multi_session_development",
                    "task_prompt": "**Session 1**\nAdd `/v1/orders`, `RATE_LIMIT_EXCEEDED`, and config/rate_limits.yml.\n\n**Session 2**\nReuse them.",
                },
            }
        ),
        encoding="utf-8",
    )
    overlay = tmp_path / "contracts.json"
    overlay.write_text(
        json.dumps(
            {
                "language_contracts": {
                    "c": [
                        {
                            "id": "project_exact_identifier_ledger",
                            "memory_type": "project",
                            "introduced_in_session": 1,
                            "description": "Project memory: save exact names.",
                            "expected_memory_fact": {
                                "required_keywords": ["Project memory", "exact names"],
                                "anchor_sources": ["prompt_config_keys", "prompt_routes", "project_headers"],
                            },
                        }
                    ]
                }
            }
        ),
        encoding="utf-8",
    )

    output = tmp_path / "prepared"
    prepare_dataset(scenarios, generated, output, limit=1, contract_overlay=overlay)
    reference = json.loads((output / "cases" / scenario_id / "scoring_reference.json").read_text())

    fact = reference["expected_memory_facts"][0]
    assert "Project memory" not in fact["required_keywords"]
    assert fact["required_keywords"][0] == "exact names"
    assert "RATE_LIMIT_EXCEEDED" in fact["required_keywords"]
    assert "/v1/orders" in fact["required_keywords"]
    assert "include/gateway.h" in fact["required_keywords"]
    checks = reference["memory_contracts"][0]["checks"]
    assert {check["source"] for check in checks} == {"auto_contract_anchor"}
    assert any(check["type"] == "require_regex" and "RATE_LIMIT_EXCEEDED" in check["pattern"] for check in checks)
    assert any(check["type"] == "require_regex" and "/v1/orders" in check["pattern"] for check in checks)
    assert any(check["type"] == "file_exists" and check["path_glob"] == "include/gateway.h" for check in checks)


def test_prepare_dataset_contract_prompt_uses_natural_convention_text(tmp_path):
    from locobench.memory_eval.prepare import _contract_followup_message

    message = _contract_followup_message(
        [
            {
                "id": "feedback_preserve_existing_style",
                "memory_type": "feedback",
                "description": "Feedback to remember: keep existing tests.",
            }
        ]
    )

    assert "Before ending Session 1" in message
    assert "Also, this repository has the following continuity contracts" in message
    assert "Keep existing tests." in message
    assert "feedback_preserve_existing_style" not in message
    assert "Feedback to remember" not in message


def test_v4_contract_overlay_is_global_tomato_memory_suite():
    overlay_path = __import__("pathlib").Path(__file__).resolve().parents[1] / "configs" / "memory_contracts_v4.json"
    overlay = json.loads(overlay_path.read_text(encoding="utf-8"))
    allowed_memory_types = {"project", "feedback", "user", "reference", "experience"}

    assert overlay.get("case_contracts") in ({}, None)
    contracts = overlay["memory_contracts"]
    assert len(contracts) == 5
    for contract in contracts:
        assert "tomato" in contract["id"]
        assert contract["memory_type"] in allowed_memory_types
        assert contract.get("expected_memory_fact", {}).get("required_keywords")
        assert contract.get("checks")
