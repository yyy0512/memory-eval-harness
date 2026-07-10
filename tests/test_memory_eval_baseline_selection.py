import json

from locobench.memory_eval.prepare import _resolve_test_plan
from scripts.memory_eval.select_baseline_post_run_cases import (
    _candidate_scenarios,
    _normalize_workspace_markdown_fences,
    _unwrap_markdown_fence,
)


def test_unwraps_backtick_and_language_tagged_triple_quote_fences():
    assert _unwrap_markdown_fence("```python\nvalue = 1\n```\n") == "value = 1\n"
    assert _unwrap_markdown_fence("'''python\nvalue = 1\n'''\n") == "value = 1\n"
    assert _unwrap_markdown_fence('"""python\nvalue = 1\n"""\n') == "value = 1\n"
    assert _unwrap_markdown_fence("```python\nvalue = 1\n") == "value = 1\n"


def test_does_not_unwrap_a_normal_python_docstring():
    text = '"""Module documentation."""\nvalue = 1\n'
    assert _unwrap_markdown_fence(text) is None


def test_workspace_normalization_repairs_build_files_and_xml_comments(tmp_path):
    cargo = tmp_path / "Cargo.toml"
    cargo.write_text("```toml\n[package]\nname = \"demo\"\n```\n", encoding="utf-8")
    pom = tmp_path / "pom.xml"
    pom.write_text("<!-- -------- -->\n<project/>\n", encoding="utf-8")

    normalized = _normalize_workspace_markdown_fences(tmp_path)

    assert normalized == ["Cargo.toml", "pom.xml"]
    assert cargo.read_text(encoding="utf-8") == '[package]\nname = "demo"\n'
    assert "--" not in pom.read_text(encoding="utf-8").removeprefix("<!--").split("-->", 1)[0]


def test_workspace_normalization_repairs_safe_maven_xml_issues(tmp_path):
    pom = tmp_path / "pom.xml"
    pom.write_text(
        """<project>
<parent><version>${spring.boot.version}</version></parent>
<description>REST & GraphQL</description>
<properties><spring.boot.version>3.2.5</spring.boot.version></properties>
</project>
""",
        encoding="utf-8",
    )

    normalized = _normalize_workspace_markdown_fences(tmp_path)

    assert normalized == ["pom.xml"]
    text = pom.read_text(encoding="utf-8")
    assert "<parent><version>3.2.5</version></parent>" in text
    assert "<description>REST &amp; GraphQL</description>" in text


def test_candidate_discovery_retries_after_safe_manifest_normalization(tmp_path):
    scenarios = tmp_path / "scenarios"
    generated = tmp_path / "generated"
    project = generated / "javascript_demo_001"
    scenarios.mkdir()
    project.mkdir(parents=True)
    scenario_id = "javascript_demo_001_multi_session_development_easy_01"
    (scenarios / f"{scenario_id}.json").write_text(
        json.dumps(
            {
                "id": scenario_id,
                "task_prompt": "**Session 1: First**\nDo A.\n\n**Session 2: Second**\nDo B.",
            }
        ),
        encoding="utf-8",
    )
    (project / "package.json").write_text(
        '```json\n{"scripts":{"test":"jest"}}\n```\n',
        encoding="utf-8",
    )
    (project / "example.test.js").write_text("test('ok', () => {});\n", encoding="utf-8")

    candidates = _candidate_scenarios(
        scenarios,
        generated,
        ["javascript"],
        normalize_markdown_fences=True,
    )

    assert len(candidates) == 1
    assert candidates[0]["test_plan"]["status"] == "configured"
    assert candidates[0]["test_plan"]["command"] == ["npm", "test"]
    assert candidates[0]["test_plan"]["source"].startswith("normalized_discovery:")


def test_php_composer_test_plan_is_resolved_before_node_package(tmp_path):
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "ExampleTest.php").write_text("<?php\n", encoding="utf-8")
    (tmp_path / "composer.json").write_text('{"scripts":{"test":"phpunit"}}', encoding="utf-8")
    (tmp_path / "package.json").write_text('{"scripts":{"test":"jest"}}', encoding="utf-8")

    plan = _resolve_test_plan(tmp_path, "php", {}, "php_demo_001", "php_demo_001_multi_session_development_easy_01")

    assert plan["source"] == "composer_test_script"
    assert plan["command"] == ["composer", "run", "test", "--no-interaction"]
    assert plan["docker_image"] == "locobench-memory-eval:php"


def test_csharp_test_project_plan_uses_dotnet_image(tmp_path):
    project = tmp_path / "tests" / "Demo.Tests"
    project.mkdir(parents=True)
    (project / "Demo.Tests.csproj").write_text("<Project />\n", encoding="utf-8")

    plan = _resolve_test_plan(tmp_path, "csharp", {}, "csharp_demo_001", "csharp_demo_001_multi_session_development_easy_01")

    assert plan["source"] == "dotnet_test_project"
    assert plan["command"] == ["dotnet", "test", "Demo.Tests.csproj", "--no-restore"]
    assert plan["docker_image"] == "locobench-memory-eval:csharp"
