#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${SHARED_BRAIN_ENV_FILE:-$ROOT/.env.shared-brain}"
TEMPLATE="$ROOT/deploy/shared-brain/tdai-gateway.yaml"
RUNTIME_DIR="$ROOT/deploy/shared-brain/.runtime"
RUNTIME_CONFIG="$RUNTIME_DIR/tdai-gateway.yaml"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE; copy .env.shared-brain.example and fill required values." >&2
  exit 2
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${MEMORY_LLM_BASE_URL:?required}"
: "${MEMORY_LLM_API_KEY:?required}"
: "${MEMORY_LLM_MODEL:?required}"
mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR"
python3 - "$TEMPLATE" "$RUNTIME_CONFIG" <<'PY'
import os, pathlib, sys
src=pathlib.Path(sys.argv[1]).read_text()
for key in ("MEMORY_LLM_BASE_URL","MEMORY_LLM_API_KEY","MEMORY_LLM_MODEL"):
    src=src.replace(f"__{key}__", os.environ[key].replace('"','\\"'))
out=pathlib.Path(sys.argv[2]); out.write_text(src); out.chmod(0o600)
PY
cd "$ROOT"
exec docker compose --env-file "$ENV_FILE" up -d --wait memory-core memory-hub
