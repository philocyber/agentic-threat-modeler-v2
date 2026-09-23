import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { bumpRAGIndexGeneration } from '@/lib/rag/index-generation'

type RAGIndexJobStatus = 'idle' | 'running' | 'succeeded' | 'failed'

export type RAGIndexJobState = {
  id: string | null
  status: RAGIndexJobStatus
  startedAt: string | null
  completedAt: string | null
  logs: string[]
  error: string | null
}

type RAGIndexGlobal = typeof globalThis & {
  __agenticTmRagIndexJob?: RAGIndexJobState
  __agenticTmRagIndexChild?: ReturnType<typeof spawn> | null
  __agenticTmRagIndexLastError?: { jobId: string; message: string } | null
}

const globalState = globalThis as RAGIndexGlobal
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g

function state(): RAGIndexJobState {
  if (!globalState.__agenticTmRagIndexJob) {
    globalState.__agenticTmRagIndexJob = {
      id: null,
      status: 'idle',
      startedAt: null,
      completedAt: null,
      logs: [],
      error: null,
    }
  }
  if (globalState.__agenticTmRagIndexJob.status === 'running' && !globalState.__agenticTmRagIndexChild) {
    globalState.__agenticTmRagIndexJob = {
      ...globalState.__agenticTmRagIndexJob,
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: 'The indexer process did not start. Try reindexing again.',
    }
  }
  return globalState.__agenticTmRagIndexJob
}

function replaceState(next: RAGIndexJobState): void {
  globalState.__agenticTmRagIndexJob = next
}

function appendLogs(jobId: string, chunk: Buffer | string, isError = false): void {
  const current = state()
  if (current.id !== jobId) return
  const lines = chunk.toString().replace(ANSI_ESCAPE, '').split(/\r?\n/).map((line) => line.trim().slice(0, 4000)).filter(Boolean)
  if (isError && lines.length > 0) {
    globalState.__agenticTmRagIndexLastError = { jobId, message: lines.at(-1) ?? '' }
  }
  replaceState({ ...current, logs: [...current.logs, ...lines].slice(-120) })
}

function failJob(jobId: string, error: string): void {
  const current = state()
  if (current.id !== jobId || current.status !== 'running') return
  replaceState({
    ...current,
    status: 'failed',
    completedAt: new Date().toISOString(),
    error,
    logs: [...current.logs, `Failed: ${error}`].slice(-120),
  })
  globalState.__agenticTmRagIndexChild = null
}

async function completeJob(jobId: string, exitCode: number | null): Promise<void> {
  const current = state()
  if (current.id !== jobId || current.status !== 'running') return
  if (exitCode !== 0) {
    const captured = globalState.__agenticTmRagIndexLastError
    failJob(
      jobId,
      captured?.jobId === jobId && captured.message
        ? captured.message
        : `Technical indexer exited with code ${exitCode ?? 'unknown'}`,
    )
    return
  }
  try {
    bumpRAGIndexGeneration()
    const latest = state()
    if (latest.id !== jobId) return
    replaceState({
      ...latest,
      status: 'succeeded',
      completedAt: new Date().toISOString(),
      error: null,
      logs: [...latest.logs, 'Technical and corporate knowledge are ready for new analyses.'].slice(-120),
    })
    globalState.__agenticTmRagIndexChild = null
  } catch (error) {
    failJob(jobId, error instanceof Error ? error.message : 'Corporate index synchronization failed')
  }
}

// The dev server inherits whatever PATH the shell had, which often lacks the
// package manager (corepack shims, `npm exec pnpm`, launchd-started servers).
// Running the indexer through the Node binary already executing this process
// plus the locally installed tsx CLI keeps it independent of PATH.
function resolveIndexerCommand(): { command: string; args: string[] } {
  const bundled = path.join(process.cwd(), 'build', 'index-knowledge-base.cjs')
  if (process.env.NODE_ENV === 'production') {
    if (!existsSync(bundled)) throw new Error('The production indexer is missing. Rebuild the standalone package.')
    return { command: process.execPath, args: [bundled] }
  }
  const script = path.join(process.cwd(), 'scripts', 'index-knowledge-base.ts')
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
  if (existsSync(tsxCli)) return { command: process.execPath, args: [tsxCli, script] }

  const binName = process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
  const tsxBin = path.join(process.cwd(), 'node_modules', '.bin', binName)
  if (existsSync(tsxBin)) return { command: tsxBin, args: [script] }

  throw new Error('tsx is not installed. Run the dependency install for this project and retry.')
}

export function getRAGIndexJob(): RAGIndexJobState {
  const current = state()
  return { ...current, logs: [...current.logs] }
}

export function startRAGIndexJob(): { started: boolean; job: RAGIndexJobState } {
  const current = state()
  if (current.status === 'running') return { started: false, job: getRAGIndexJob() }

  const jobId = randomUUID()
  replaceState({
    id: jobId,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    logs: ['Starting the technical knowledge indexer...'],
    error: null,
  })
  globalState.__agenticTmRagIndexLastError = null

  let child: ReturnType<typeof spawn>
  try {
    const { command, args } = resolveIndexerCommand()
    child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '0' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    globalState.__agenticTmRagIndexChild = child
  } catch (error) {
    failJob(jobId, error instanceof Error ? error.message : 'The indexer process could not be started')
    return { started: false, job: getRAGIndexJob() }
  }
  child.stdout?.on('data', (chunk: Buffer) => appendLogs(jobId, chunk))
  child.stderr?.on('data', (chunk: Buffer) => appendLogs(jobId, chunk, true))
  child.on('error', (error) => failJob(jobId, error.message))
  child.on('close', (code) => void completeJob(jobId, code))

  return { started: true, job: getRAGIndexJob() }
}
