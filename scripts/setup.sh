#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

ACTION="start"
INSTALL_DOCKER=0
LIGHT=0
NO_OPEN=0
PROVIDER=""

usage() {
  cat <<'EOF'
Usage: ./scripts/setup.sh [start|doctor|stop|status|logs] [options]

Options:
  --install-docker  Install Docker Desktop with Homebrew when it is missing.
  --light           Use one 4B analysis model and the 0.6B embedding model.
  --provider NAME   Choose ollama, google, kimi, cursor, or bedrock without a menu.
  --no-open         Do not open the browser after startup.
EOF
}

while (($#)); do
  case "$1" in
    start|doctor|stop|status|logs) ACTION="$1" ;;
    --install-docker) INSTALL_DOCKER=1 ;;
    --light) LIGHT=1 ;;
    --provider) [[ $# -ge 2 ]] || { echo '--provider needs a value.' >&2; exit 2; }; PROVIDER="$2"; shift ;;
    --no-open) NO_OPEN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

ENV_FILE="$PROJECT_ROOT/.env.docker"
ENV_EXAMPLE="$PROJECT_ROOT/.env.docker.example"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.local.yml)

step() { printf '\n==> %s\n' "$1"; }

initialize_environment() {
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    echo 'Created .env.docker from the reviewed example.'
  fi
  chmod 600 "$ENV_FILE"
}

get_env_value() {
  awk -v name="$1" 'index($0, name "=") == 1 { value=substr($0, length(name)+2) } END { print value }' "$ENV_FILE" | tr -d '\r'
}

set_env_value() {
  local name="$1" value="$2" temporary
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || { echo "$name must be a single line." >&2; exit 1; }
  temporary="$(mktemp "${ENV_FILE}.XXXXXX")"
  chmod 600 "$temporary"
  awk -v name="$name" 'index($0, name "=") != 1 { print }' "$ENV_FILE" > "$temporary"
  printf '%s=%s\n' "$name" "$value" >> "$temporary"
  mv "$temporary" "$ENV_FILE"
}

read_secret() {
  local name="$1" value
  [[ -t 0 ]] || { echo "$name is missing. Set it in .env.docker before a non-interactive start." >&2; exit 1; }
  read -r -s -p "$name (input hidden): " value
  printf '\n'
  [[ -n "$value" ]] || { echo "$name is required for the selected provider." >&2; exit 1; }
  [[ "$value" != *"'"* ]] || { echo "$name cannot contain a single quote in the installer. Edit .env.docker manually for this key." >&2; exit 1; }
  set_env_value "$name" "'$value'"
}

select_provider() {
  local selected="$PROVIDER" mode choice name
  if [[ -z "$selected" && "$(get_env_value SETUP_PROVIDER_SELECTED)" == true ]]; then selected="$(get_env_value LLM_PROVIDER)"; fi
  if [[ -z "$selected" ]]; then
    [[ -t 0 ]] || { echo 'Choose an inference provider with --provider ollama|google|kimi|cursor|bedrock before a non-interactive start.' >&2; exit 1; }
    printf '\nChoose how Argus will run inference:\n  1. API key (no Ollama model downloads)\n  2. Local Ollama models (about 12.5 GB standard, less with --light)\n'
    read -r -p 'Choice [1/2]: ' mode
    case "$mode" in
      2) selected=ollama ;;
      1)
        printf '  1. Google Gemini  2. Kimi  3. Cursor  4. AWS Bedrock\n'
        read -r -p 'API provider [1-4]: ' choice
        case "$choice" in 1) selected=google ;; 2) selected=kimi ;; 3) selected=cursor ;; 4) selected=bedrock ;; *) echo 'Choose an API provider from 1 to 4.' >&2; exit 1 ;; esac
        ;;
      *) echo 'Choose 1 for an API provider or 2 for local models.' >&2; exit 1 ;;
    esac
  fi
  case "$selected" in ollama|google|kimi|cursor|bedrock) ;; *) echo "Unsupported provider in .env.docker: $selected" >&2; exit 1 ;; esac
  set_env_value LLM_PROVIDER "$selected"
  if [[ "$selected" == ollama ]]; then set_env_value RAG_DEFAULT_ENABLED true; else set_env_value RAG_DEFAULT_ENABLED false; fi
  set_env_value SETUP_PROVIDER_SELECTED true
  export LLM_PROVIDER="$selected"
  export RAG_DEFAULT_ENABLED="$(get_env_value RAG_DEFAULT_ENABLED)"

  case "$selected" in
    google) required=(GOOGLE_API_KEY) ;;
    kimi) required=(KIMI_API_KEY) ;;
    cursor) required=(CURSOR_API_KEY) ;;
    bedrock) required=(BEDROCK_AWS_ACCESS_KEY_ID BEDROCK_AWS_SECRET_ACCESS_KEY) ;;
    *) required=() ;;
  esac
  for name in "${required[@]}"; do
    [[ -n "$(get_env_value "$name")" || -n "${!name:-}" ]] || read_secret "$name"
  done
  if [[ "$selected" == ollama ]] && ((LIGHT)); then
    export OLLAMA_QUICK_MODEL='qwen3.5:4b'
    export OLLAMA_DEEP_MODEL='qwen3.5:4b'
    export EMBEDDING_MODEL='qwen3-embedding:0.6b'
    export OLLAMA_QUICK_NUM_CTX='8192'
    export OLLAMA_DEEP_NUM_CTX='8192'
    echo 'Using the light profile: one 4B analysis model and the 0.6B embedding model.'
  fi
  if [[ "$selected" != ollama ]] && ((LIGHT)); then echo 'Warning: --light applies only to Ollama models; no models will be downloaded.'; fi
  echo "Inference provider: $selected"
}

install_docker_desktop() {
  if [[ "$(uname -s)" != 'Darwin' ]]; then
    echo 'Automatic Docker installation is supported only on macOS. Follow the official Docker Engine instructions for this Linux distribution.' >&2
    exit 1
  fi
  if ! command -v brew >/dev/null 2>&1; then
    echo 'Homebrew is required for automated installation. Install Docker Desktop from https://docs.docker.com/desktop/setup/install/mac-install/ and rerun.' >&2
    exit 1
  fi
  step 'Installing Docker Desktop with Homebrew'
  brew install --cask docker-desktop
}

ensure_docker_cli() {
  if command -v docker >/dev/null 2>&1; then return; fi
  if ((INSTALL_DOCKER)); then
    install_docker_desktop
  elif [[ -t 0 ]]; then
    read -r -p 'Docker Desktop is missing. Install it with Homebrew? This requires accepting Docker Desktop terms [y/N] ' answer
    case "$answer" in y|Y|yes|YES|s|S|si|SI|sí|SÍ) install_docker_desktop ;; *) exit 1 ;; esac
  else
    echo 'Docker Desktop is required. Rerun with --install-docker or install it from the official Docker documentation.' >&2
    exit 1
  fi
  command -v docker >/dev/null 2>&1 || { echo 'Docker was installed but its CLI is not available yet. Open a new terminal and rerun.' >&2; exit 1; }
}

docker_ready() { docker info >/dev/null 2>&1; }

start_docker_desktop() {
  docker_ready && return
  step 'Starting Docker Desktop'
  docker desktop start --timeout 120 >/dev/null 2>&1 || true
  if ! docker_ready && [[ "$(uname -s)" == 'Darwin' ]]; then open -a Docker; fi
  for _ in $(seq 1 60); do
    docker_ready && return
    sleep 3
  done
  echo 'Docker Desktop did not become ready within three minutes. Complete any first-run prompts and rerun.' >&2
  exit 1
}

doctor() {
  echo 'Argus Docker doctor'
  echo "Repository: $PROJECT_ROOT"
  echo "Architecture: $(uname -m)"
  if [[ "$(uname -s)" == 'Darwin' ]]; then
    memory_bytes="$(sysctl -n hw.memsize 2>/dev/null || true)"
    if [[ "$memory_bytes" =~ ^[0-9]+$ ]]; then
      memory_gb=$((memory_bytes / 1024 / 1024 / 1024))
      echo "System memory: ${memory_gb} GB"
      ((memory_gb >= 16)) || echo 'Warning: less than 16 GB RAM detected; use --light.'
    fi
  fi
  free_kb="$(df -Pk "$PROJECT_ROOT" | awk 'NR==2 {print $4}')"
  if [[ "$free_kb" =~ ^[0-9]+$ ]]; then
    free_gb=$((free_kb / 1024 / 1024))
    echo "Free disk: ${free_gb} GB"
    ((free_gb >= 30)) || echo 'Warning: the standard profile may need more than 30 GB free; use --light.'
  fi
  command -v docker >/dev/null 2>&1 || { echo 'Docker CLI: missing'; return 1; }
  docker --version
  docker compose version
  docker_ready || { echo 'Docker daemon: not running'; return 1; }
  os_type="$(docker info --format '{{.OSType}}')"
  echo "Docker daemon: ready ($os_type containers)"
  [[ "$os_type" == 'linux' ]] || { echo 'Argus requires Docker Desktop Linux containers.' >&2; return 1; }
}

app_port() {
  if [[ -n "${APP_PORT:-}" ]]; then echo "$APP_PORT"; return; fi
  awk -F= '/^APP_PORT=/{print $2; exit}' "$ENV_FILE" | tr -d '\r' | grep . || echo 8080
}

wait_for_app() {
  local port="$1" url="http://127.0.0.1:$1/api/health"
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then return; fi
    sleep 3
  done
  "${COMPOSE[@]}" ps
  echo "Argus did not become ready at $url. Run ./scripts/setup.sh logs to inspect the stack." >&2
  exit 1
}

initialize_environment
if [[ "$ACTION" == start ]]; then select_provider; fi

if [[ "$ACTION" == 'doctor' ]]; then
  doctor
  "${COMPOSE[@]}" config --quiet
  echo 'Compose configuration: valid'
  exit 0
fi

ensure_docker_cli
start_docker_desktop
doctor
"${COMPOSE[@]}" config --quiet

case "$ACTION" in
  stop)
    step 'Stopping Argus without deleting persistent data'
    "${COMPOSE[@]}" down
    exit 0
    ;;
  status) "${COMPOSE[@]}" ps; exit 0 ;;
  logs) "${COMPOSE[@]}" logs --follow --tail 200; exit 0 ;;
esac

if [[ "$LLM_PROVIDER" == ollama ]]; then
  step 'Starting Ollama and Chroma'
  "${COMPOSE[@]}" up -d ollama chromadb
  step 'Preparing the configured Ollama models (the first run downloads several GB)'
  "${COMPOSE[@]}" run --rm ollama-models
else
  step 'Starting Chroma without downloading Ollama models'
  "${COMPOSE[@]}" stop ollama
  "${COMPOSE[@]}" up -d chromadb
fi

step 'Building and starting Argus and pipeline-worker'
"${COMPOSE[@]}" up --build -d app worker

PORT="$(app_port)"
wait_for_app "$PORT"
"${COMPOSE[@]}" ps
APP_URL="http://127.0.0.1:$PORT"
printf '\nArgus is ready: %s\n' "$APP_URL"
echo 'Persistent Docker volumes keep projects, knowledge, vectors and models across restarts.'
if [[ "$LLM_PROVIDER" != ollama ]]; then echo 'Cloud inference is selected. Knowledge retrieval is off by default; local Ollama is needed if you enable it later.'; fi
echo 'Stop safely with: ./scripts/setup.sh stop'
if ((NO_OPEN == 0)); then
  if [[ "$(uname -s)" == 'Darwin' ]]; then open "$APP_URL"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$APP_URL" >/dev/null 2>&1 || true; fi
fi
