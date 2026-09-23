import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadDevelopmentEnv } from './dev.mjs'
loadDevelopmentEnv()
process.env.AGENTICTM_ENV_FILE = resolve('.env.local')
process.env.KNOWLEDGE_BASE_PATH = resolve(process.env.KNOWLEDGE_BASE_PATH || 'knowledge_base')
process.env.PAGE_INDICES_PATH = resolve(process.env.PAGE_INDICES_PATH || 'data/page_indices')
const env = { ...process.env, HOSTNAME: '127.0.0.1', PORT: process.env.PORT || '3000' }
const workerScript = existsSync(resolve('build/pipeline-worker.cjs'))
  ? resolve('build/pipeline-worker.cjs')
  : resolve('node_modules/tsx/dist/cli.mjs')
const workerArgs = workerScript.endsWith('pipeline-worker.cjs')
  ? []
  : [resolve('scripts/pipeline-worker.ts')]
const children = [
  spawn(process.execPath, [resolve('.next/standalone/server.js')], { stdio: 'inherit', env }),
  spawn(process.execPath, [workerScript, ...workerArgs], { stdio: 'inherit', env }),
]
const interrupt = () => { for (const child of children) child.kill('SIGINT') }
const terminate = () => { for (const child of children) child.kill('SIGTERM') }
process.on('SIGINT', interrupt)
process.on('SIGTERM', terminate)
for (const child of children) {
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', code => {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
    for (const other of children) {
      if (other !== child) other.kill('SIGTERM')
    }
    process.exitCode = code ?? 1
  })
}
