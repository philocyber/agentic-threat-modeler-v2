import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('local Docker installation', () => {
  it('keeps the complete local runtime inside the Compose network', () => {
    const compose = read('docker-compose.local.yml')

    expect(compose).toContain('name: agentictm')
    expect(compose).toContain('ollama:')
    expect(compose).toContain('ollama-models:')
    expect(compose).toContain('profiles: [local-models]')
    expect(compose).toContain('app:')
    expect(compose).toContain('worker:')
    expect(compose).toContain('OLLAMA_BASE_URL: http://ollama:11434')
    expect(compose).toContain('CHROMA_HOST: chromadb')
    expect(compose).toContain('127.0.0.1:${APP_PORT:-8080}:8080')
    expect(compose).not.toContain('host.docker.internal')
    expect(compose).toContain('RAG_DEFAULT_ENABLED: ${RAG_DEFAULT_ENABLED:-true}')
  })

  it('persists primary data, derived indexes, and downloaded models', () => {
    const base = read('docker-compose.yml')
    const local = read('docker-compose.local.yml')

    expect(base).toContain('chroma_data:')
    expect(local).toContain('workspace_data:')
    expect(local).toContain('knowledge_data:')
    expect(local).toContain('ollama_data:')
  })

  it('ships launchers and a non-secret configuration template', () => {
    const windows = read('scripts/setup.ps1')
    const commandPrompt = read('scripts/setup.cmd')
    const macos = read('scripts/setup.sh')
    const environment = read('.env.docker.example')

    for (const launcher of [windows, macos]) {
      expect(launcher).toContain('docker-compose.local.yml')
      expect(launcher).toContain('ollama-models')
      expect(launcher).toContain('/api/health')
      expect(launcher).not.toContain('down -v')
    }
    expect(windows).toContain("if ($selectedProvider -eq 'ollama')")
    expect(macos).toContain('if [[ "$LLM_PROVIDER" == ollama ]]')
    expect(windows).toContain('RAG_DEFAULT_ENABLED')
    expect(macos).toContain('RAG_DEFAULT_ENABLED')
    expect(windows).toContain('Read-Host "$Name (input hidden)" -AsSecureString')
    expect(macos).toContain('read -r -s -p "$name (input hidden): " value')
    expect(commandPrompt).toContain('setup.ps1')
    expect(commandPrompt).toContain('%*')
    expect(environment).toContain('OLLAMA_IMAGE=ollama/ollama:0.34.1')
    expect(environment).not.toMatch(/^[A-Z0-9_]*(KEY|TOKEN|SECRET)=.+$/m)
  })
})
