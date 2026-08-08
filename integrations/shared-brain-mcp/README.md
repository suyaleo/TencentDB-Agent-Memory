# Shared Brain MCP

Additive stdio MCP integration for Hermes, Codex CLI, Grok CLI, and agy CLI. It preserves each host's existing model/OAuth route.

## Environment

```bash
export TDAI_MEMORY_ENDPOINT=http://127.0.0.1:8420
export TDAI_MEMORY_API_KEY='...'
export TDAI_MEMORY_SERVICE_ID=default
export TDAI_TEAM_ID='...'
export TDAI_AGENT_ID='...'
export TDAI_USER_ID='...'
export TDAI_TASK_ID='...'
```

Use the repository virtual environment entrypoint:

```bash
integrations/shared-brain-mcp/run.sh
```

Tools: `memory_recall`, `memory_search`, `conversation_search`, `memory_capture`, `memory_session_end`, `skill_list`, `skill_get`, `skill_publish`. Publishing defaults to dry-run.

## Agent registration

```bash
# Codex
codex mcp add shared-brain -- /absolute/repo/integrations/shared-brain-mcp/run.sh

# Grok
grok mcp add --scope user shared-brain -- /absolute/repo/integrations/shared-brain-mcp/run.sh
```

Hermes config:

```yaml
mcp_servers:
  shared_brain:
    command: /absolute/repo/integrations/shared-brain-mcp/run.sh
    args: []
    sampling:
      enabled: false
```

agy (`~/.gemini/config/mcp_config.json`):

```json
{
  "mcpServers": {
    "shared-brain": {
      "command": "/absolute/repo/integrations/shared-brain-mcp/run.sh",
      "args": []
    }
  }
}
```

## Safety

- Inventory is metadata-only.
- Skill import defaults to dry-run and blocks secret-like content.
- Raw transcripts are not bulk-imported by these scripts.
- Review ACL/team/agent bindings in Memory Hub before publishing shared assets.
