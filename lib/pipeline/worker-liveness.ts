import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { desc, gt } from 'drizzle-orm'
import { z } from 'zod'
import { pipelineWorkers } from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import { PIPELINE_WORKER_STALE_MS } from '@/lib/pipeline/lease'
import { PIPELINE_WORKER_CODE_VERSION } from '@/lib/contracts/versions'
import { workerCodeVersionOf } from '@/lib/pipeline/worker-version'

const LocalHeartbeatSchema = z.object({
  instanceId: z.string().trim().min(1).max(128),
  at: z.number().int().positive(),
  pid: z.number().int().positive(),
  codeVersion: z.string().trim().min(1).max(64).optional(),
})

export type WorkerLiveness = {
  status: 'up' | 'down'
  lastSeenAt: string | null
  instanceId?: string | null
  codeVersion?: string | null
}

function localHeartbeatPath(): string {
  const configured = process.env.AGENTICTM_WORKSPACE_ROOT
  const root = resolve(configured || join(homedir(), '.agentictm', 'projects'))
  const target = join(root, '.pipeline-worker.json')
  const rel = relative(root, target)
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new Error('Invalid worker heartbeat path')
  }
  return target
}

async function recordLocalHeartbeat(instanceId: string): Promise<void> {
  const target = localHeartbeatPath()
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const body = JSON.stringify({
    instanceId,
    at: Date.now(),
    pid: process.pid,
    codeVersion: workerCodeVersionOf(instanceId) ?? PIPELINE_WORKER_CODE_VERSION,
  })
  const tmp = `${target}.${process.pid}.tmp`
  await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, target)
}

async function readLocalHeartbeat(): Promise<WorkerLiveness> {
  try {
    const parsed = LocalHeartbeatSchema.safeParse(JSON.parse(await readFile(localHeartbeatPath(), 'utf8')))
    if (!parsed.success) return { status: 'down', lastSeenAt: null }
    const lastSeenAt = new Date(parsed.data.at).toISOString()
    return {
      status: Date.now() - parsed.data.at <= PIPELINE_WORKER_STALE_MS ? 'up' : 'down',
      lastSeenAt,
      instanceId: parsed.data.instanceId,
      codeVersion: parsed.data.codeVersion ?? workerCodeVersionOf(parsed.data.instanceId),
    }
  } catch {
    return { status: 'down', lastSeenAt: null }
  }
}

async function recordPostgresHeartbeat(instanceId: string): Promise<void> {
  const { db } = await import('@/lib/db')
  const now = new Date()
  await db
    .insert(pipelineWorkers)
    .values({
      instanceId,
      heartbeatAt: now,
      startedAt: now,
    })
    .onConflictDoUpdate({
      target: pipelineWorkers.instanceId,
      set: { heartbeatAt: now },
    })
}

async function readPostgresHeartbeat(): Promise<WorkerLiveness> {
  const { db } = await import('@/lib/db')
  const threshold = new Date(Date.now() - PIPELINE_WORKER_STALE_MS)
  const [live] = await db
    .select({ heartbeatAt: pipelineWorkers.heartbeatAt, instanceId: pipelineWorkers.instanceId })
    .from(pipelineWorkers)
    .where(gt(pipelineWorkers.heartbeatAt, threshold))
    .orderBy(desc(pipelineWorkers.heartbeatAt))
    .limit(1)
  if (live) {
    return {
      status: 'up',
      lastSeenAt: live.heartbeatAt.toISOString(),
      instanceId: live.instanceId,
      codeVersion: workerCodeVersionOf(live.instanceId),
    }
  }
  const [latest] = await db
    .select({ heartbeatAt: pipelineWorkers.heartbeatAt, instanceId: pipelineWorkers.instanceId })
    .from(pipelineWorkers)
    .orderBy(desc(pipelineWorkers.heartbeatAt))
    .limit(1)
  return {
    status: 'down',
    lastSeenAt: latest?.heartbeatAt?.toISOString() ?? null,
    instanceId: latest?.instanceId ?? null,
    codeVersion: workerCodeVersionOf(latest?.instanceId),
  }
}

/** Best-effort: a liveness write must never abort a running analysis. */
export async function recordWorkerLiveness(instanceId: string): Promise<void> {
  try {
    if (process.env.DATABASE_URL) await recordPostgresHeartbeat(instanceId)
    else await recordLocalHeartbeat(instanceId)
  } catch (error) {
    logger.warn('Failed to record pipeline worker liveness', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function readWorkerLiveness(): Promise<WorkerLiveness> {
  try {
    if (process.env.DATABASE_URL) return await readPostgresHeartbeat()
    return await readLocalHeartbeat()
  } catch {
    return { status: 'down', lastSeenAt: null }
  }
}

export function __localHeartbeatPathForTests(): string {
  return localHeartbeatPath()
}
