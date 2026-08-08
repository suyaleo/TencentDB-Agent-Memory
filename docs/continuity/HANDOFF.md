# Handoff

## Objective
Run and validate the shared-brain stack and connect all four CLIs.

## Current state
MCP bridge, deployment overlay, and Studio continuity metadata are implemented but runtime verification is in progress.

## Decisions and invariants
See `docs/decisions/DECISIONS.md`; preserve MIT and native model/OAuth routes.

## Files changed
Use `git status --short` and `git diff --stat`.

## Verification
Run MCP unit tests, MemoryPanel build, Compose config, health checks, and cross-agent recall.

## Next exact action
Start `deploy/shared-brain-start.sh`, initialize the admin/user/team/agents, then register MCP with Hermes/Codex/Grok/agy.

## Risks or blockers
Studio's provided schema rejects MIT and the upstream repository name. Existing raw sessions require human-reviewed import policy.
