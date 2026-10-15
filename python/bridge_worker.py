"""Small, dependency-free Python sidecar for deterministic file tasks.

The sidecar is deliberately a data worker: it never evaluates Python, shell,
or page supplied code.  Higher-level document/data adapters can be added as
explicit operations after they have their own policy and tests.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MAX_TASK_BYTES = 64 * 1024
MAX_READ_BYTES = 8 * 1024 * 1024
OPS = frozenset((
    "hash_file", "read_text", "list_files",
    "read_json", "read_csv", "write_json", "write_csv",
))


class TaskError(ValueError):
    pass


@dataclass(frozen=True)
class Task:
    id: str
    op: str
    path: str | None = None
    encoding: str = "utf-8"
    max_bytes: int = MAX_READ_BYTES
    timeout_ms: int = 30_000
    value: Any = None
    rows: Any = None
    headers: Any = None
    max_rows: int = 10_000

    @classmethod
    def parse(cls, value: dict[str, Any]) -> "Task":
        if not isinstance(value, dict):
            raise TaskError("task must be an object")
        task_id, op = value.get("id"), value.get("op")
        if not isinstance(task_id, str) or not task_id or len(task_id) > 128:
            raise TaskError("id must be a non-empty string of at most 128 characters")
        if op not in OPS:
            raise TaskError(f"unsupported operation: {op!r}")
        path = value.get("path")
        if not isinstance(path, str) or not path:
            raise TaskError("path is required")
        encoding = value.get("encoding", "utf-8")
        if not isinstance(encoding, str) or len(encoding) > 64:
            raise TaskError("invalid encoding")
        max_bytes = value.get("max_bytes", MAX_READ_BYTES)
        timeout_ms = value.get("timeout_ms", 30_000)
        if not isinstance(max_bytes, int) or not 0 < max_bytes <= MAX_READ_BYTES:
            raise TaskError(f"max_bytes must be between 1 and {MAX_READ_BYTES}")
        if not isinstance(timeout_ms, int) or not 0 < timeout_ms <= 300_000:
            raise TaskError("timeout_ms must be between 1 and 300000")
        max_rows = value.get("max_rows", 10_000)
        if not isinstance(max_rows, int) or not 0 < max_rows <= 100_000:
            raise TaskError("max_rows must be between 1 and 100000")
        if op == "write_json" and "value" not in value:
            raise TaskError("value is required for write_json")
        if op == "write_csv":
            if not isinstance(value.get("rows"), list):
                raise TaskError("rows must be a list for write_csv")
            if value.get("headers") is not None and not isinstance(value.get("headers"), list):
                raise TaskError("headers must be a list for write_csv")
        return cls(task_id, op, path, encoding, max_bytes, timeout_ms,
                   value.get("value"), value.get("rows"), value.get("headers"), max_rows)


def _root(path: str, roots: list[Path]) -> Path:
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        raise TaskError("path must be absolute")
    resolved = candidate.resolve(strict=False)
    for root in roots:
        root_resolved = root.resolve(strict=True)
        try:
            resolved.relative_to(root_resolved)
            return resolved
        except ValueError:
            continue
    raise TaskError("path is outside configured worker roots")


def _check_size(path: Path, limit: int) -> None:
    if not path.is_file():
        raise TaskError("path is not a regular file")
    if path.stat().st_size > limit:
        raise TaskError("file exceeds task max_bytes")


def _write_bytes(path: Path, payload: bytes, limit: int) -> None:
    if len(payload) > limit:
        raise TaskError("output exceeds task max_bytes")
    path.parent.mkdir(parents=True, exist_ok=True)
    # Replace atomically so readers never observe a partially written artifact.
    temporary = path.with_name(f".{path.name}.bridge-tmp-{os.getpid()}")
    try:
        temporary.write_bytes(payload)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def execute(task: Task, roots: list[Path]) -> dict[str, Any]:
    started = time.monotonic()
    path = _root(task.path or "", roots)
    if task.op == "hash_file":
        _check_size(path, task.max_bytes)
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        result: Any = {"sha256": digest.hexdigest(), "bytes": path.stat().st_size}
    elif task.op == "read_text":
        _check_size(path, task.max_bytes)
        try:
            result = {"text": path.read_text(encoding=task.encoding), "bytes": path.stat().st_size}
        except (LookupError, UnicodeError) as exc:
            raise TaskError(f"cannot decode file: {exc}") from exc
    elif task.op == "read_json":
        _check_size(path, task.max_bytes)
        try:
            parsed = json.loads(path.read_text(encoding=task.encoding))
        except (LookupError, UnicodeError, json.JSONDecodeError) as exc:
            raise TaskError(f"cannot parse JSON: {exc}") from exc
        if len(json.dumps(parsed, ensure_ascii=False).encode("utf-8")) > task.max_bytes:
            raise TaskError("parsed JSON exceeds task max_bytes")
        result = {"value": parsed, "bytes": path.stat().st_size}
    elif task.op == "read_csv":
        _check_size(path, task.max_bytes)
        try:
            with path.open("r", encoding=task.encoding, newline="") as stream:
                reader = csv.DictReader(stream)
                headers = reader.fieldnames or []
                rows = []
                for row in reader:
                    if len(rows) >= task.max_rows:
                        raise TaskError("CSV exceeds max_rows")
                    rows.append(dict(row))
        except (LookupError, UnicodeError, csv.Error) as exc:
            raise TaskError(f"cannot parse CSV: {exc}") from exc
        result = {"headers": headers, "rows": rows, "bytes": path.stat().st_size}
    elif task.op == "write_json":
        payload = json.dumps(task.value, ensure_ascii=False, indent=2).encode("utf-8")
        _write_bytes(path, payload, task.max_bytes)
        result = {"bytes": len(payload), "path": str(path)}
    elif task.op == "write_csv":
        rows = task.rows or []
        if len(rows) > task.max_rows:
            raise TaskError("rows exceeds max_rows")
        headers = task.headers
        if headers is None:
            keys = {key for row in rows if isinstance(row, dict) for key in row}
            headers = sorted(keys)
        if not all(isinstance(key, str) and key for key in headers):
            raise TaskError("CSV headers must be non-empty strings")
        if not all(isinstance(row, dict) for row in rows):
            raise TaskError("CSV rows must be objects")
        import io
        buffer = io.StringIO(newline="")
        writer = csv.DictWriter(buffer, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
        payload = buffer.getvalue().encode("utf-8")
        _write_bytes(path, payload, task.max_bytes)
        result = {"bytes": len(payload), "path": str(path), "headers": headers, "rows": len(rows)}
    else:  # list_files
        if not path.is_dir():
            raise TaskError("path is not a directory")
        entries = []
        for item in sorted(path.iterdir(), key=lambda p: p.name.casefold()):
            # Do not follow symlinks out of the configured root.
            resolved = item.resolve(strict=False)
            try:
                resolved.relative_to(path)
            except ValueError:
                continue
            entries.append({"name": item.name, "kind": "directory" if item.is_dir() else "file"})
        result = {"entries": entries}
    elapsed = int((time.monotonic() - started) * 1000)
    if elapsed > task.timeout_ms:
        raise TimeoutError("task exceeded timeout_ms")
    return {"id": task.id, "op": task.op, "result": result, "elapsed_ms": elapsed}


def health() -> dict[str, Any]:
    return {"ok": True, "service": "ai-browser-python-worker", "version": "0.2.0", "ops": sorted(OPS)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AI Browser Bridge deterministic Python worker")
    parser.add_argument("--health", action="store_true")
    parser.add_argument("--roots", nargs="+", help="allowed absolute directories")
    args = parser.parse_args(argv)
    if args.health:
        print(json.dumps(health(), ensure_ascii=False))
        return 0
    if not args.roots:
        print(json.dumps({"ok": False, "error": "--roots is required"}), ensure_ascii=False)
        return 2
    roots = [Path(root).resolve(strict=True) for root in args.roots]
    for line in sys.stdin:
        if len(line.encode()) > MAX_TASK_BYTES:
            response = {"ok": False, "error": "task exceeds maximum size"}
        else:
            try:
                task = Task.parse(json.loads(line))
                response = {"ok": True, **execute(task, roots)}
            except (TaskError, TimeoutError, json.JSONDecodeError, OSError) as exc:
                response = {"ok": False, "error": str(exc)}
        print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
