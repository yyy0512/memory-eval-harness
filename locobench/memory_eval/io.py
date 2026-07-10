"""Filesystem helpers for the LoCoBench memory evaluation harness."""

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any, Dict, Iterable, List


def read_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def read_jsonl(path: Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def write_jsonl(path: Path, rows: Iterable[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False))
            handle.write("\n")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_tree(root: Path) -> str:
    digest = hashlib.sha256()
    if not root.exists():
        return ""
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = path.relative_to(root).as_posix()
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(sha256_file(path).encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def sha256_prepared_case(case_dir: Path) -> str:
    """Hash the immutable case payload without the self-describing case.json."""
    digest = hashlib.sha256()
    if not case_dir.exists():
        return ""
    case_descriptor = case_dir / "case.json"
    for path in sorted(p for p in case_dir.rglob("*") if p.is_file() and p != case_descriptor):
        rel = path.relative_to(case_dir).as_posix()
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(sha256_file(path).encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def sha256_prepared_dataset(prepared_dir: Path) -> str:
    """Hash manifest and case payloads, excluding the summary that records this hash."""
    digest = hashlib.sha256()
    paths: List[Path] = []
    manifest = prepared_dir / "manifest.jsonl"
    if manifest.is_file():
        paths.append(manifest)
    cases_dir = prepared_dir / "cases"
    if cases_dir.exists():
        paths.extend(sorted(path for path in cases_dir.rglob("*") if path.is_file()))
    for path in paths:
        rel = path.relative_to(prepared_dir).as_posix()
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(sha256_file(path).encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def copy_tree_clean(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns(".git", ".gitignore", "__pycache__", ".DS_Store"))


def snapshot_directory(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    if src.exists():
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__", ".DS_Store"))
    else:
        dst.mkdir(parents=True, exist_ok=True)


def tree_file_hashes(root: Path) -> Dict[str, str]:
    """Return content hashes for workspace files, excluding harness-internal git state."""
    hashes: Dict[str, str] = {}
    if not root.exists():
        return hashes
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = path.relative_to(root)
        if rel.parts and rel.parts[0] == ".git":
            continue
        try:
            hashes[rel.as_posix()] = sha256_file(path)
        except OSError:
            continue
    return hashes


def snapshot_workspace_delta(root: Path, before: Dict[str, str], dst: Path) -> Dict[str, Any]:
    """Snapshot files added or modified since ``before`` plus a deletion manifest."""
    if dst.exists():
        shutil.rmtree(dst)
    files_dir = dst / "files"
    files_dir.mkdir(parents=True, exist_ok=True)

    after = tree_file_hashes(root)
    added = sorted(path for path in after if path not in before)
    modified = sorted(path for path in after if path in before and after[path] != before[path])
    deleted = sorted(path for path in before if path not in after)
    copied: List[str] = []
    skipped: List[str] = []
    nontext_or_large: List[str] = []
    for rel in added + modified:
        source = root / rel
        target = files_dir / rel
        try:
            with source.open("rb") as handle:
                sample = handle.read(8192)
            if source.stat().st_size > 5 * 1024 * 1024 or b"\0" in sample:
                nontext_or_large.append(rel)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            copied.append(rel)
        except OSError:
            skipped.append(rel)

    manifest: Dict[str, Any] = {
        "schema_version": "memory_eval_workspace_delta_v1",
        "added": added,
        "modified": modified,
        "deleted": deleted,
        "copied": copied,
        "not_copied_nontext_or_large": nontext_or_large,
        "copy_errors": skipped,
    }
    write_json(dst / "manifest.json", manifest)
    return manifest
