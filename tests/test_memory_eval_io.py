from locobench.memory_eval.io import read_jsonl, sha256_tree, write_jsonl
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
