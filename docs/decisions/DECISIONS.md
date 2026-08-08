# Decisions

1. Upstream MIT license and `TencentDB-Agent-Memory` identity remain canonical.
2. The provided Leo Studio schema cannot represent MIT or this upstream repository name; this is recorded as a validator incompatibility rather than hidden by relicensing.
3. Ubuntu is the runtime host. Docker ports bind to `127.0.0.1` by default.
4. MCP is additive. It does not proxy or replace agent inference.
5. Existing transcripts are not bulk-uploaded automatically. Skills are secret-scanned and dry-run by default.
6. Image references are pinned to inspected linux/amd64 digests.
