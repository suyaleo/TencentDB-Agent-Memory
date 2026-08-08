#!/usr/bin/env bash
set -euo pipefail
AGENT="${1:?usage: run-agent.sh hermes|codex|grok|agy}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME="$ROOT/deploy/shared-brain/.runtime"
set -a
# shellcheck disable=SC1091
source "$RUNTIME/mcp.env"
set +a
case "$AGENT" in
  hermes) LABEL='Hermes Orchestrator' ;;
  codex) LABEL='Codex Builder' ;;
  grok) LABEL='Grok Researcher' ;;
  agy) LABEL='AGY Specialist' ;;
  *) echo "unknown agent: $AGENT" >&2; exit 2 ;;
esac
export TDAI_AGENT_ID="$(python3 - "$RUNTIME/scope.json" "$LABEL" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['agents'][sys.argv[2]])
PY
)"
exec "$ROOT/integrations/shared-brain-mcp/run.sh"
