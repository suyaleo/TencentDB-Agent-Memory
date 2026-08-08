# TencentDB Agent Memory — Shared Brain Overlay

- Preserve the upstream architecture and MIT `LICENSE`.
- The Ubuntu deployment is additive: do not replace Hermes, Codex, Grok, or agy model/OAuth routes.
- Shared knowledge, memory, and skills flow through MemoryCore and `integrations/shared-brain-mcp`.
- Never commit secrets, raw credentials, browser state, or unreviewed transcript dumps.
- Asset inventory and import are dry-run by default; require explicit review before `--apply`.
- Keep service ports loopback-only unless external ingress and authentication are separately approved.
- Run MCP unit tests, the MemoryPanel production build, and `docker compose config` before release.
- Do not commit, push, tag, publish, or change repository visibility without separate user authority.
