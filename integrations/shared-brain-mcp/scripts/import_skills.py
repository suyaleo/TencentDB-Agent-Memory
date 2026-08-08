#!/usr/bin/env python3
"""Review-first skill importer. Dry-run by default; refuses secret-like content."""
from __future__ import annotations

import argparse
import importlib.util
import json
import pathlib
import re
from typing import Any

SECRET_PATTERNS = [
    re.compile(r"(?i)(api[_-]?key|token|password|secret)\s*[:=]\s*\S+"),
    re.compile(r"\b(?:sk|ghp|xai)-[A-Za-z0-9_-]{12,}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
]


def load_bridge(path: pathlib.Path) -> Any:
    spec = importlib.util.spec_from_file_location("shared_brain_import_bridge", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def discover(roots: list[pathlib.Path]) -> list[pathlib.Path]:
    found: dict[str, pathlib.Path] = {}
    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob("SKILL.md"):
            if not path.is_file():
                continue
            # Symlinked compatibility roots are legitimate, but only import the
            # canonical target once and never follow a target outside $HOME.
            resolved = path.resolve()
            try:
                resolved.relative_to(pathlib.Path.home().resolve())
            except ValueError:
                continue
            found[str(resolved)] = resolved
    return sorted(found.values())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-agent", required=True, choices=["hermes", "codex", "grok", "agy"])
    parser.add_argument("--root", action="append", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    bridge = load_bridge(pathlib.Path(__file__).parents[1] / "server.py")
    results = []
    for path in discover([pathlib.Path(p).expanduser() for p in args.root]):
        content = path.read_text("utf-8", errors="replace")
        unsafe = any(pattern.search(content) for pattern in SECRET_PATTERNS)
        name_match = re.search(r"(?m)^name:\s*[\"']?([^\"'\n]+)", content)
        name = name_match.group(1).strip() if name_match else path.parent.name
        row: dict[str, Any] = {
            "path": str(path), "name": name, "chars": len(content),
            "source_agent": args.source_agent, "blocked_secret_scan": unsafe,
            "applied": False,
        }
        if args.apply and not unsafe:
            row["result"] = bridge.skill_publish(name, content, args.source_agent, apply=True)
            row["applied"] = True
        results.append(row)
    report = {"dry_run": not args.apply, "skills": results}
    print(json.dumps(report, ensure_ascii=False, indent=2) if args.json else "\n".join(
        f"{'BLOCK' if r['blocked_secret_scan'] else 'IMPORT' if r['applied'] else 'DRY'} {r['path']}" for r in results
    ))


if __name__ == "__main__":
    main()
