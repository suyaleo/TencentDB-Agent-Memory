#!/usr/bin/env python3
"""Secret-safe asset inventory. Reads metadata only; never emits file content."""
from __future__ import annotations

import argparse
import json
import pathlib
from typing import Any

HOME = pathlib.Path.home()
ROOTS = {
    "hermes": [HOME / ".hermes" / "skills", HOME / ".hermes" / "sessions"],
    "codex": [HOME / ".codex" / "skills", HOME / ".codex" / "sessions"],
    "grok": [HOME / ".grok" / "skills", HOME / ".grok" / "sessions", HOME / ".grok" / "memory"],
    "agy": [HOME / ".agents" / "skills", HOME / ".gemini" / "antigravity-cli"],
}
ALLOWED = {".md", ".json", ".jsonl", ".yaml", ".yml", ".toml"}


def inspect_root(root: pathlib.Path) -> dict[str, Any]:
    counts: dict[str, int] = {}
    total = 0
    if not root.exists():
        return {"path": str(root), "exists": False, "files": 0, "bytes": 0, "types": {}}
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink() or path.suffix.lower() not in ALLOWED:
            continue
        counts[path.suffix.lower()] = counts.get(path.suffix.lower(), 0) + 1
        try:
            total += path.stat().st_size
        except OSError:
            pass
    return {"path": str(root), "exists": True, "files": sum(counts.values()), "bytes": total, "types": counts}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    report = {
        "mode": "metadata-only",
        "content_read": False,
        "credentials_read": False,
        "agents": {agent: [inspect_root(root) for root in roots] for agent, roots in ROOTS.items()},
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for agent, entries in report["agents"].items():
            print(agent)
            for entry in entries:
                print(f"  {entry['path']}: {entry['files']} files, {entry['bytes']} bytes")


if __name__ == "__main__":
    main()
