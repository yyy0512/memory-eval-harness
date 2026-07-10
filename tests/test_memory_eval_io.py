from locobench.memory_eval.io import (
    read_json,
    read_jsonl,
    sha256_tree,
    snapshot_workspace_delta,
    tree_file_hashes,
    write_jsonl,
)
from locobench.memory_eval.schema import TokenMetrics


def test_token_metrics_from_result_computes_derived_counts():
    result = {
        "usage": {
            "input_tokens": 10,
            "output_tokens": 3,
            "cache_creation_input_tokens": 5,
            "cache_read_input_tokens": 7,
        },
        "total_cost_usd": 0.25,
        "duration_ms": 1200,
        "duration_api_ms": 900,
    }

    metrics = TokenMetrics.from_result(result)

    assert metrics.input_tokens == 10
    assert metrics.output_tokens == 3
    assert metrics.new_input_output_tokens == 13
    assert metrics.total_reported_tokens == 25
    assert metrics.total_cost_usd == 0.25
    assert metrics.duration_ms == 1200
    assert metrics.duration_api_ms == 900


def test_jsonl_round_trip(tmp_path):
    path = tmp_path / "rows.jsonl"
    rows = [{"a": 1}, {"b": "two"}]

    write_jsonl(path, rows)

    assert read_jsonl(path) == rows


def test_sha256_tree_changes_when_file_content_changes(tmp_path):
    root = tmp_path / "tree"
    root.mkdir()
    file_path = root / "file.txt"
    file_path.write_text("one", encoding="utf-8")
    first = sha256_tree(root)

    file_path.write_text("two", encoding="utf-8")
    second = sha256_tree(root)

    assert first != second


def test_snapshot_workspace_delta_records_only_current_session_changes(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "kept.txt").write_text("before\n", encoding="utf-8")
    (workspace / "deleted.txt").write_text("remove\n", encoding="utf-8")
    before = tree_file_hashes(workspace)

    (workspace / "kept.txt").write_text("after\n", encoding="utf-8")
    (workspace / "deleted.txt").unlink()
    (workspace / "new.txt").write_text("new\n", encoding="utf-8")
    snapshot = tmp_path / "delta"
    snapshot_workspace_delta(workspace, before, snapshot)

    manifest = read_json(snapshot / "manifest.json")
    assert manifest["added"] == ["new.txt"]
    assert manifest["modified"] == ["kept.txt"]
    assert manifest["deleted"] == ["deleted.txt"]
    assert (snapshot / "files" / "kept.txt").read_text(encoding="utf-8") == "after\n"
