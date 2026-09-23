import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

const COMPOSE_FILES = ['-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml']
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function loadDevelopmentEnv() {
  // Exported values win over local files, as they do in the application.
  loadEnv({ path: '.env.local', quiet: true })
  loadEnv({ path: '.env', quiet: true })
}

/** @param {Record<string, string | undefined>} env */
export function requiredServices(env = process.env) {
  const services = []
  if (LOCAL_HOSTS.has(env.CHROMA_HOST ?? 'localhost')) services.push('chromadb')
  if (env.DATABASE_URL && LOCAL_HOSTS.has(new URL(env.DATABASE_URL).hostname)) services.push('postgres-db')
  return services
}

/** @param {Record<string, string | undefined>} env */
export function effectiveOllamaModels(env = process.env) {
  return [...new Set([
    ...((env.LLM_PROVIDER ?? 'ollama') === 'ollama'
      ? [env.OLLAMA_QUICK_MODEL || env.OLLAMA_MODEL || 'qwen3.5:4b', env.OLLAMA_DEEP_MODEL || env.OLLAMA_MODEL || 'qwen3.5:9b']
      : []),
    env.EMBEDDING_MODEL || 'qwen3-embedding:4b',
  ])]
}

function dockerCommand() {
  if (spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0) return 'docker'
  const candidates = [
    join(homedir(), 'AppData', 'Local', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'),
    'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
  ]
  const executable = candidates.find((candidate) => existsSync(candidate))
  if (!executable) throw new Error('Docker is unavailable. Start Docker Desktop or run without RAG using dev:next.')
  process.env.PATH = `${dirname(executable)}${delimiter}${process.env.PATH ?? ''}`
  return executable
}

function compose(docker, args, stdio = 'inherit') {
  const result = spawnSync(docker, ['compose', ...COMPOSE_FILES, ...args], { stdio, env: process.env })
  if (result.error || result.status !== 0) throw new Error('Docker Compose failed. Check the Docker daemon and compose configuration.')
}

export async function waitUntilReady(check, { timeoutMs = 90_000, intervalMs = 1000, label = 'Service' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`${label} did not become ready within ${Math.round(timeoutMs / 1000)} seconds.`)
}

async function ensureServices() {
  const services = requiredServices()
  if (!services.length) return
  const docker = dockerCommand()
  // Reconcile every required service even when Chroma already responds.
  compose(docker, ['up', '-d', ...services])
  for (const service of services) {
    await waitUntilReady(async () => {
      const result = spawnSync(docker, ['compose', ...COMPOSE_FILES, 'ps', '--format', 'json', service], { encoding: 'utf8' })
      if (result.status !== 0) return false
      try {
        const output = result.stdout.trim()
        const rows = output.startsWith('[') ? JSON.parse(output) : output.split('\n').filter(Boolean).map((line) => JSON.parse(line))
        return rows.length > 0 && rows.every((row) => row.State === 'running' && row.Health === 'healthy')
      } catch { return false }
    }, { label: service })
  }
  console.log(`[dev] Ready: ${services.join(', ')}`)
}

function runManaged(commands) {
  const children = commands.map(([script, args]) =>
    spawn(process.execPath, [script, ...args], { stdio: 'inherit', env: process.env }))
  const interrupt = () => { for (const child of children) child.kill('SIGINT') }
  const terminate = () => { for (const child of children) child.kill('SIGTERM') }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  for (const child of children) {
    child.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
    child.on('exit', (code) => {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
      for (const other of children) {
        if (other !== child) other.kill('SIGTERM')
      }
      process.exitCode = code ?? 1
    })
  }
}

async function main() {
  loadDevelopmentEnv()
  const [action = 'start', ...args] = process.argv.slice(2)
  if (action === 'services-down') return compose(dockerCommand(), ['down'])
  if (action === 'services-up') return ensureServices()
  if (action === 'models') {
    for (const model of effectiveOllamaModels()) {
      const result = spawnSync('ollama', ['pull', model], { stdio: 'inherit', env: process.env })
      if (result.status !== 0) throw new Error(`Could not prepare Ollama model ${model}. Check Ollama and the selected model name.`)
    }
    return
  }
  if (action !== 'start') throw new Error(`Unknown development command: ${action}`)
  try { await ensureServices() } catch (error) {
    console.warn(`[dev] ${error.message} Continuing with the local UI; analyses can explicitly disable RAG.`)
  }
  runManaged([
    [resolve('node_modules/next/dist/bin/next'), ['dev', '--webpack', '--hostname', '127.0.0.1', ...args]],
    [resolve('node_modules/tsx/dist/cli.mjs'), [resolve('scripts/pipeline-worker.ts')]],
  ])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[dev] ${error.message}`); process.exitCode = 1 })
}
