# Docker local

Docker Desktop is the only host dependency in the recommended local installation. The Compose stack contains Argus, `pipeline-worker`, and Chroma. Ollama and its one-shot model initializer run only when local inference is selected. PostgreSQL is not part of this single-user path: each project keeps its own SQLite database and artifacts in the workspace volume.

## Install and start

From the repository root:

```bat
:: Windows Command Prompt
scripts\setup.cmd
```

```powershell
# Windows PowerShell
.\scripts\setup.ps1
```

```bash
# macOS
bash scripts/setup.sh
```

The launcher performs these checks and actions in order:

1. Detect the operating system, architecture, free disk, memory, Docker CLI, Compose plugin, daemon and Linux-container engine.
2. Offer an explicit Docker Desktop installation when Docker is missing (`winget` on Windows, Homebrew on macOS).
3. Create the Git-ignored `.env.docker` file from `.env.docker.example` without overwriting an existing configuration. Ask whether to use an API key or local models; remember the selection for later starts. An existing configuration keeps its selected provider. Use `-Provider` or `--provider` to switch.
4. For API inference, request any missing provider credential without echoing it, start Chroma, and leave Ollama stopped. For local inference, start Ollama and Chroma.
5. Download configured analysis and embedding models only for local inference.
6. Build and start the app and worker, wait for `/api/health`, print service status and open http://127.0.0.1:8080.

Docker Desktop may require a license agreement, virtualization/WSL setup, privileged configuration, or a host restart. The launcher never bypasses those operating-system prompts.

## Resource profiles

The standard local-model profile uses:

| Role | Model | Published package size |
| --- | --- | ---: |
| Quick analysis | `qwen3.5:4b` | 3.4 GB |
| Deep analysis | `qwen3.5:9b` | 6.6 GB |
| Embeddings | `qwen3-embedding:4b` | 2.5 GB |

Allow at least 30 GB of free disk for model data, base images and build layers. Runtime memory depends on context and Docker Desktop allocation; 16 GB system RAM is a practical minimum for the standard profile, not a guarantee of acceptable speed.

For smaller machines:

```powershell
.\scripts\setup.ps1 -Light
```

```bat
scripts\setup.cmd start -Light
```

```bash
bash scripts/setup.sh --light
```

The light profile uses `qwen3.5:4b` for both analysis tiers, `qwen3-embedding:0.6b` for retrieval and 8K analysis contexts. It reduces download and memory pressure, with a corresponding quality and evidence-retention trade-off.

For API inference, select Google Gemini, Kimi, Cursor, or AWS Bedrock in the first-run menu. The launcher stores entered credentials in `.env.docker`, which is ignored by Git. For unattended setup, select a provider explicitly and put its credential variables in `.env.docker` or the process environment before starting. The app defaults to that provider and turns off knowledge retrieval. No Ollama image or model layers are downloaded on this path. Docker still downloads the app's base images and Chroma. To enable knowledge retrieval later, select local inference or install and configure the Ollama embedding service and model separately.

Ollama in Docker is the portable CPU baseline. Docker Desktop on macOS does not expose Metal acceleration to this Linux container, so native Ollama is faster on Apple hardware. Keeping the default fully containerized path prioritizes reproducibility; a host-Ollama accelerator profile can be added separately after it has its own tests and support contract.

## Configuration

The first run creates `.env.docker`, which is excluded from Git. In API mode it holds credentials in plain text. Keep it private, never commit or share it, and restrict file access to your account. Edit it before the next start to change ports, model tags, contexts, timeouts or provider credentials. The app and worker use the private Compose network; only the Argus UI is published, bound to loopback.

Changing a model tag is safe. The next launcher run pulls missing layers and reuses existing ones. Old model layers remain in the `ollama_data` volume until deliberately removed with Ollama tooling.

Docker mode sets `CREDENTIALS_READ_ONLY=true`: configure cloud credentials in `.env.docker`, not through the browser. RAG embeddings still use the local Ollama service even when a cloud analysis provider is selected. API-mode runs default to RAG off, and the health indicator treats that as intentional.

## Operations

```powershell
.\scripts\setup.ps1 doctor
.\scripts\setup.ps1 status
.\scripts\setup.ps1 logs
.\scripts\setup.ps1 stop
```

From Command Prompt, use the same actions with `scripts\setup.cmd`, for example `scripts\setup.cmd doctor` or `scripts\setup.cmd stop`.

```bash
bash scripts/setup.sh doctor
bash scripts/setup.sh status
bash scripts/setup.sh logs
bash scripts/setup.sh stop
```

`stop` runs Compose `down` without `-v`, so named volumes survive. Do not use `down -v` unless project workspaces, knowledge, vectors and downloaded models are intentionally being deleted.

The equivalent manual startup is:

```bash
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.local.yml up -d chromadb
# Local inference only:
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.local.yml up -d ollama
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.local.yml run --rm ollama-models
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.local.yml up --build -d app worker
```

## Data and backup

Named volumes have separate responsibilities:

- `workspace_data`: project SQLite databases, inputs, manifests, checkpoints and exports.
- `knowledge_data`: approved source corpus mounted into app and worker.
- `chroma_data`: derived retrieval index.
- `ollama_data`: downloaded local models.

Stop Argus before making a coherent backup. Back up `workspace_data` and `knowledge_data` as primary data. Chroma can be rebuilt from the reviewed corpus, and Ollama models can be downloaded again, but preserving those volumes shortens recovery.

The separate `docker-compose.service.yml` remains an evaluation profile for PostgreSQL/shared-service work. It is not required by this local installation and must not be exposed as a multi-user service without the documented security review.
