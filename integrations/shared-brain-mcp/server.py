#!/usr/bin/env python3
"""TencentDB Agent Memory stdio MCP bridge.

Additive integration: it never changes the host CLI's model or OAuth route.
Requires the Python `mcp` package in the interpreter used to launch it.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("tencentdb-shared-brain")
BASE_URL = os.environ.get("TDAI_MEMORY_ENDPOINT", "http://127.0.0.1:8420").rstrip("/")
USER_KEY = os.environ.get("TDAI_MEMORY_API_KEY", "")
GATEWAY_API_KEY = os.environ.get("TDAI_MEMORY_GATEWAY_API_KEY", "local")
SERVICE_ID = os.environ.get("TDAI_MEMORY_SERVICE_ID", "default")
TEAM_ID = os.environ.get("TDAI_TEAM_ID", "")
AGENT_ID = os.environ.get("TDAI_AGENT_ID", "")
USER_ID = os.environ.get("TDAI_USER_ID", "")
TASK_ID = os.environ.get("TDAI_TASK_ID", "")
TIMEOUT = float(os.environ.get("TDAI_MEMORY_TIMEOUT", "30"))


def _post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    headers = {
        "Content-Type": "application/json",
        "x-tdai-service-id": SERVICE_ID,
    }
    # v2/v3 routes require a non-empty Authorization header even when the
    # standalone Gateway's shared-secret gate is disabled. The user key is a
    # separate Layer-3 identity header used for ACLs.
    if GATEWAY_API_KEY:
        headers["Authorization"] = f"Bearer {GATEWAY_API_KEY}"
    if USER_KEY:
        headers["x-tdai-user-key"] = USER_KEY
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"MemoryCore {path} returned HTTP {exc.code}: {raw[:500]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"MemoryCore unavailable at {BASE_URL}: {exc.reason}") from exc
    value = json.loads(raw) if raw else {}
    if not isinstance(value, dict):
        raise RuntimeError(f"MemoryCore {path} returned a non-object response")
    return value


def _scope(**overrides: str | None) -> dict[str, str]:
    values = {
        "team_id": overrides.get("team_id") or TEAM_ID,
        "agent_id": overrides.get("agent_id") or AGENT_ID,
        "user_id": overrides.get("user_id") or USER_ID,
        "task_id": overrides.get("task_id") or TASK_ID,
    }
    return {key: value for key, value in values.items() if value}


@mcp.tool()
def memory_recall(query: str, session_key: str, user_id: str = "") -> dict[str, Any]:
    """Recall relevant L1/L2/L3 memory before starting or continuing work."""
    body: dict[str, Any] = {"query": query, "session_key": session_key}
    if user_id or USER_ID:
        body["user_id"] = user_id or USER_ID
    return _post("/recall", body)


@mcp.tool()
def memory_search(query: str, limit: int = 5, memory_type: str = "") -> dict[str, Any]:
    """Search structured long-term L1 memories."""
    body: dict[str, Any] = {"query": query, "limit": max(1, min(limit, 20))}
    if memory_type:
        body["type"] = memory_type
    return _post("/search/memories", body)


@mcp.tool()
def conversation_search(query: str, limit: int = 5, session_key: str = "") -> dict[str, Any]:
    """Search raw L0 conversation history."""
    body: dict[str, Any] = {"query": query, "limit": max(1, min(limit, 20))}
    if session_key:
        body["session_key"] = session_key
    return _post("/search/conversations", body)


@mcp.tool()
def memory_capture(user_content: str, assistant_content: str, session_key: str, session_id: str = "", user_id: str = "") -> dict[str, Any]:
    """Capture a completed user/assistant turn into L0 for asynchronous extraction."""
    body: dict[str, Any] = {
        "user_content": user_content,
        "assistant_content": assistant_content,
        "session_key": session_key,
    }
    if session_id:
        body["session_id"] = session_id
    if user_id or USER_ID:
        body["user_id"] = user_id or USER_ID
    return _post("/capture", body)


@mcp.tool()
def memory_session_end(session_key: str, user_id: str = "") -> dict[str, Any]:
    """Flush pending extraction work for a session."""
    body: dict[str, Any] = {"session_key": session_key}
    if user_id or USER_ID:
        body["user_id"] = user_id or USER_ID
    return _post("/session/end", body)


@mcp.tool()
def skill_list(query: str = "", limit: int = 50, offset: int = 0) -> dict[str, Any]:
    """List or search shared skills for the configured agent scope."""
    body: dict[str, Any] = {**_scope(), "limit": max(1, min(limit, 100)), "offset": max(0, offset)}
    path = "/v3/skill/list"
    if query:
        body["query"] = query
        path = "/v3/skill/search"
    return _post(path, body)


@mcp.tool()
def skill_get(skill_id: str) -> dict[str, Any]:
    """Fetch a shared skill, including its versioned SKILL.md content."""
    return _post("/v3/skill/get", {**_scope(), "skill_id": skill_id})


@mcp.tool()
def skill_publish(name: str, content: str, source_agent: str, apply: bool = False) -> dict[str, Any]:
    """Publish a reviewed SKILL.md. Defaults to dry-run; set apply only after review."""
    preview = {
        "dry_run": not apply,
        "name": name,
        "source_agent": source_agent,
        "content_chars": len(content),
        "scope": _scope(),
    }
    if not apply:
        return preview
    if not TEAM_ID or not AGENT_ID or not USER_ID:
        raise ValueError("TDAI_TEAM_ID, TDAI_AGENT_ID, and TDAI_USER_ID are required to publish")
    return _post(
        "/v3/skill/create",
        {
            **_scope(),
            "name": name,
            "content": content,
            "metadata": {"source_agent": source_agent, "imported_by": "shared-brain-mcp"},
        },
    )


if __name__ == "__main__":
    mcp.run(transport="stdio")
