from __future__ import annotations

import importlib.util
import json
import pathlib
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

SERVER_PATH = pathlib.Path(__file__).parents[1] / "server.py"


class Handler(BaseHTTPRequestHandler):
    calls: list[tuple[str, dict[str, Any]]] = []

    def do_POST(self) -> None:
        size = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(size) or b"{}")
        self.calls.append((self.path, body))
        payload = {"ok": True, "path": self.path, "body": body}
        raw = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, format: str, *args: Any) -> None:
        del format, args


class BridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        spec = importlib.util.spec_from_file_location("shared_brain_server", SERVER_PATH)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        cls.mod: Any = module
        cls.mod.BASE_URL = f"http://127.0.0.1:{cls.httpd.server_port}"
        cls.mod.TEAM_ID = "team-test"
        cls.mod.AGENT_ID = "agent-test"
        cls.mod.USER_ID = "user-test"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self) -> None:
        Handler.calls.clear()

    def test_recall_contract(self) -> None:
        result = self.mod.memory_recall("decision", "session-1")
        self.assertTrue(result["ok"])
        self.assertEqual(Handler.calls[-1], ("/recall", {"query": "decision", "session_key": "session-1", "user_id": "user-test"}))

    def test_capture_contract(self) -> None:
        self.mod.memory_capture("u", "a", "session-1")
        path, body = Handler.calls[-1]
        self.assertEqual(path, "/capture")
        self.assertEqual(body["assistant_content"], "a")

    def test_skill_dry_run_does_not_write(self) -> None:
        result = self.mod.skill_publish("demo", "---\nname: demo\n---\n", "grok")
        self.assertTrue(result["dry_run"])
        self.assertEqual(Handler.calls, [])

    def test_skill_search_scope(self) -> None:
        self.mod.skill_list("docker", limit=999)
        path, body = Handler.calls[-1]
        self.assertEqual(path, "/v3/skill/search")
        self.assertEqual(body["limit"], 100)
        self.assertEqual(body["team_id"], "team-test")


if __name__ == "__main__":
    unittest.main()
