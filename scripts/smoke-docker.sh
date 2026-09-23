#!/usr/bin/env sh
set -eu
image=${1:-agentictm-smoke}
container="agentictm-smoke-$$"
workspace_volume="${container}-workspaces"
knowledge_volume="${container}-knowledge"
fixture=$(mktemp -d)
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$workspace_volume" "$knowledge_volume" >/dev/null 2>&1 || true
  rm -rf "$fixture"
}
trap cleanup EXIT
# Every resource belongs to this smoke. No host corpus or credentials are mounted.
docker volume create "$workspace_volume" >/dev/null
docker volume create "$knowledge_volume" >/dev/null
start() {
  docker run -d --name "$container" -p 127.0.0.1::8080 \
    -e AGENTICTM_WORKSPACE_ROOT=/home/nextjs/.agentictm/projects \
    -e KNOWLEDGE_BASE_PATH=/app/knowledge_base \
    -v "$workspace_volume:/home/nextjs/.agentictm" \
    -v "$knowledge_volume:/app/knowledge_base" "$image" >/dev/null
  port=$(docker port "$container" 8080/tcp | sed 's/.*://')
  base="http://127.0.0.1:$port"
  attempt=0
  until curl -fsS "$base/api/health" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then docker logs "$container"; exit 1; fi
    sleep 1
  done
}
start
status=$(curl -sS -o "$fixture/project.json" -w '%{http_code}' -H "Origin: $base" -H 'Content-Type: application/json' -d '{"name":"Synthetic Docker smoke"}' "$base/api/v1/projects")
[ "$status" = 201 ] || { cat "$fixture/project.json"; exit 1; }
printf '# Synthetic source\nReview sample access quarterly.\n' > "$fixture/source.md"
status=$(curl -sS -o "$fixture/upload.json" -w '%{http_code}' -H "Origin: $base" -F domain=technical -F destination=technical-general -F "files=@$fixture/source.md" "$base/api/v1/knowledge")
[ "$status" = 201 ] || { cat "$fixture/upload.json"; exit 1; }
status=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT -H "Origin: $base" -H 'Content-Type: application/json' -d '{}' "$base/api/v1/llm/credentials")
[ "$status" = 403 ]
docker exec "$container" node -e "require('pdf-parse'); require('node:fs').accessSync('build/index-knowledge-base.cjs'); require('node:fs').accessSync('drizzle/sqlite/meta/_journal.json')"
docker rm -f "$container" >/dev/null
start
curl -fsS "$base/api/v1/projects" -o "$fixture/projects.json"
curl -fsS "$base/api/v1/knowledge" -o "$fixture/knowledge.json"
python3 - "$fixture" <<'PY'
from pathlib import Path
import json, sys
root = Path(sys.argv[1])
assert len(json.loads((root/'projects.json').read_text())['data']) == 1, 'Project did not survive recreation'
assert len(json.loads((root/'knowledge.json').read_text())['files']) == 1, 'Source did not survive recreation'
PY
printf '%s\n' 'Docker smoke passed: SQLite, source upload, volume persistence after recreation, readonly credentials and PDF/indexer runtime.'
