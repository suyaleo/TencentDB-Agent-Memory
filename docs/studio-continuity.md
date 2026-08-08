# Studio continuity for the shared brain

This repository keeps the upstream TencentDB Agent Memory architecture and adds
an Ubuntu deployment overlay for Hermes, Codex CLI, Grok CLI, and agy CLI.

The continuity metadata lives in [`studio/project.json`](../studio/project.json),
with executable start and release contracts in
[`studio/start-contract.json`](../studio/start-contract.json) and
[`studio/release-contract.json`](../studio/release-contract.json).

## Validator compatibility is documented, not hidden

The provided Studio validator schema rejects this project because it rejects
both the upstream `TencentDB-Agent-Memory` repository name and its upstream MIT
license. Those values are intentionally recorded truthfully in the manifest.
The upstream [`LICENSE`](../LICENSE) is the legal source of truth and must not
be changed to make a validator pass. This repository therefore treats the
validator result as a known schema incompatibility, not as permission to rename
the project or relicense it.

## Start / release boundary

Start with `./deploy/shared-brain-start.sh`, or run the equivalent
`docker compose --env-file .env.shared-brain up -d`. The compose overlay wraps
the existing `deploy/global-images` images and adds the stdio MCP integration.
By default, service ports bind only to loopback.

Release requires the checks in the release contract. Agent setup artifacts only
append an MCP tool registration: existing model selection, API base URL, API
key, and OAuth paths remain the operator's existing CLI configuration.

No credentials are stored in this repository. Inventory/import commands redact
secret-like values, record provenance, and remain dry-run unless `--apply` is
provided.
