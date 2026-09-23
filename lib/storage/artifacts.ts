import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { artifacts as sqliteArtifacts } from '@/lib/db/schema.sqlite'
import { runArtifacts as postgresRunArtifacts } from '@/lib/db/schema'
import { getStorage } from './context'
import { CheckpointWriteError } from '@/lib/pipeline/checkpoint-error'
import { logger } from '@/lib/logger'
import {
  activeWorkspaceOrNull,
  appendProgressEvent,
  appendTelemetryEvent,
  readWorkspaceText,
  sha256Hex,
  writeArtifactAtomic,
} from '@/lib/workspace/artifacts'

export const MAX_RUN_ARTIFACT_BYTES = 32 * 1024 * 1024
const PHASE_ARTIFACT_PREFIX = 'phase:'
const jsonlWrites = new Map<string, Promise<void>>()

export type RunArtifactInput = {
  runId: string
  kind: string
  relativePath: string
  mimeType: string
  sha256: string
  sizeBytes: number
}

export type StoredRunArtifact = {
  runId: string
  kind: string
  relativePath: string
  mimeType: string
  sha256: string
  sizeBytes: number
}

function assertArtifactSize(content: string, kind: string): void {
  const sizeBytes = Buffer.byteLength(content)
  if (sizeBytes > MAX_RUN_ARTIFACT_BYTES) {
    throw new CheckpointWriteError(
      `Checkpoint ${kind} exceeds the ${MAX_RUN_ARTIFACT_BYTES} byte durable-store limit`,
    )
  }
}

export async function getRunArtifact(runId: string, kind: string): Promise<StoredRunArtifact | null> {
  const storage = getStorage()
  if (storage.kind === 'sqlite') {
    const [row] = await storage.db.select().from(sqliteArtifacts).where(and(
      eq(sqliteArtifacts.runId, runId),
      eq(sqliteArtifacts.kind, kind),
    ))
    return row ?? null
  }
  const [row] = await storage.db.select({
    runId: postgresRunArtifacts.runId,
    kind: postgresRunArtifacts.kind,
    mimeType: postgresRunArtifacts.mimeType,
    sha256: postgresRunArtifacts.sha256,
    sizeBytes: postgresRunArtifacts.sizeBytes,
  }).from(postgresRunArtifacts).where(and(
    eq(postgresRunArtifacts.runId, runId),
    eq(postgresRunArtifacts.kind, kind),
  ))
  if (!row) return null
  return {
    ...row,
    relativePath: `postgres:${kind}`,
  }
}

export async function getRunArtifactText(runId: string, kind: string): Promise<string | null> {
  const storage = getStorage()
  if (storage.kind === 'sqlite') {
    const workspace = activeWorkspaceOrNull()
    if (!workspace) return null
    // The worker appends these mutable logs directly to disk. They have no
    // checkpoint catalog row or fixed checksum, including on historical runs.
    if (kind === 'progress.jsonl' || kind === 'telemetry.jsonl') {
      try {
        return await readWorkspaceText(workspace, `runs/${runId}/${kind}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    }
    const artifact = await getRunArtifact(runId, kind)
    if (!artifact) return null
    const content = await readWorkspaceText(workspace, artifact.relativePath)
    if (sha256Hex(content) !== artifact.sha256) {
      throw new CheckpointWriteError(`Artifact ${kind} failed SHA-256 verification`)
    }
    return content
  }
  const [row] = await storage.db.select().from(postgresRunArtifacts).where(and(
    eq(postgresRunArtifacts.runId, runId),
    eq(postgresRunArtifacts.kind, kind),
  ))
  if (!row) return null
  if (sha256Hex(row.content) !== row.sha256) {
    throw new CheckpointWriteError(`Artifact ${kind} failed SHA-256 verification`)
  }
  return row.content
}

export async function listCompletedPhases(runId: string): Promise<string[]> {
  const storage = getStorage()
  if (storage.kind === 'sqlite') {
    const rows = await storage.db
      .select({ kind: sqliteArtifacts.kind })
      .from(sqliteArtifacts)
      .where(eq(sqliteArtifacts.runId, runId))
      .orderBy(asc(sqliteArtifacts.createdAt))
    return rows
      .filter((row) => row.kind.startsWith(PHASE_ARTIFACT_PREFIX))
      .map((row) => row.kind.slice(PHASE_ARTIFACT_PREFIX.length))
  }
  const rows = await storage.db
    .select({ kind: postgresRunArtifacts.kind })
    .from(postgresRunArtifacts)
    .where(eq(postgresRunArtifacts.runId, runId))
    .orderBy(asc(postgresRunArtifacts.createdAt))
  return rows
    .filter((row) => row.kind.startsWith(PHASE_ARTIFACT_PREFIX))
    .map((row) => row.kind.slice(PHASE_ARTIFACT_PREFIX.length))
}

/**
 * Registers a filesystem catalog row. Local workspaces only; Postgres stores
 * content through putRunArtifactContent.
 */
export async function registerRunArtifact(input: RunArtifactInput): Promise<void> {
  const storage = getStorage()
  if (storage.kind !== 'sqlite') return
  await storage.db.insert(sqliteArtifacts).values({
    id: randomUUID(),
    runId: input.runId,
    kind: input.kind,
    relativePath: input.relativePath,
    mimeType: input.mimeType,
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
  }).onConflictDoUpdate({
    target: [sqliteArtifacts.runId, sqliteArtifacts.kind],
    set: {
      relativePath: input.relativePath,
      mimeType: input.mimeType,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      createdAt: new Date(),
    },
  })
}

export async function putRunArtifactContent(input: {
  runId: string
  kind: string
  content: string
  mimeType: string
  relativePath?: string
}): Promise<{ sha256: string; sizeBytes: number }> {
  assertArtifactSize(input.content, input.kind)
  const workspace = activeWorkspaceOrNull()
  const storage = getStorage()
  if (workspace && storage.kind === 'sqlite') {
    const relativePath = input.relativePath ?? `runs/${input.runId}/${input.kind.replace(/:/g, '/')}`
    const written = await writeArtifactAtomic(workspace, relativePath, input.content)
    await registerRunArtifact({
      runId: input.runId,
      kind: input.kind,
      relativePath,
      mimeType: input.mimeType,
      ...written,
    })
    return written
  }
  if (storage.kind !== 'postgres') {
    throw new CheckpointWriteError(`No durable store is available for checkpoint ${input.kind}`)
  }
  const sha256 = sha256Hex(input.content)
  const sizeBytes = Buffer.byteLength(input.content)
  const now = new Date()
  await storage.db.insert(postgresRunArtifacts).values({
    id: randomUUID(),
    runId: input.runId,
    kind: input.kind,
    sha256,
    sizeBytes,
    mimeType: input.mimeType,
    content: input.content,
    createdAt: now,
  }).onConflictDoUpdate({
    target: [postgresRunArtifacts.runId, postgresRunArtifacts.kind],
    set: {
      sha256,
      sizeBytes,
      mimeType: input.mimeType,
      content: input.content,
    },
  })
  return { sha256, sizeBytes }
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: string; cause?: { code?: string } }
  return candidate.code === '23505' || candidate.cause?.code === '23505'
}

async function appendPostgresJsonl(
  runId: string,
  kind: string,
  event: Record<string, unknown>,
): Promise<void> {
  const storage = getStorage()
  if (storage.kind !== 'postgres') {
    throw new CheckpointWriteError(`No durable store is available for checkpoint ${kind}`)
  }
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await storage.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(postgresRunArtifacts)
          .where(and(eq(postgresRunArtifacts.runId, runId), eq(postgresRunArtifacts.kind, kind)))
          .for('update')
        if (row && sha256Hex(row.content) !== row.sha256) {
          throw new CheckpointWriteError(`Artifact ${kind} failed SHA-256 verification`)
        }
        const content = `${row?.content ?? ''}${line}`
        assertArtifactSize(content, kind)
        const sha256 = sha256Hex(content)
        const sizeBytes = Buffer.byteLength(content)
        if (row) {
          await tx
            .update(postgresRunArtifacts)
            .set({ sha256, sizeBytes, mimeType: 'application/x-ndjson', content })
            .where(eq(postgresRunArtifacts.id, row.id))
          return
        }
        await tx.insert(postgresRunArtifacts).values({
          id: randomUUID(),
          runId,
          kind,
          sha256,
          sizeBytes,
          mimeType: 'application/x-ndjson',
          content,
          createdAt: new Date(),
        })
      })
      return
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 2) throw error
    }
  }
}

async function appendDurableJsonl(runId: string, kind: string, event: Record<string, unknown>): Promise<void> {
  const workspace = activeWorkspaceOrNull()
  if (workspace) {
    if (kind === 'progress.jsonl') {
      await appendProgressEvent(workspace, runId, event)
      return
    }
    if (kind === 'telemetry.jsonl') {
      await appendTelemetryEvent(workspace, runId, event)
      return
    }
  }
  const key = `${runId}:${kind}`
  const write = (jsonlWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (getStorage().kind === 'postgres') {
      await appendPostgresJsonl(runId, kind, event)
      return
    }
    const previous = (await getRunArtifactText(runId, kind)) ?? ''
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`
    await putRunArtifactContent({
      runId,
      kind,
      content: `${previous}${line}`,
      mimeType: 'application/x-ndjson',
      relativePath: `runs/${runId}/${kind}`,
    })
  })
  jsonlWrites.set(key, write)
  try {
    await write
  } catch (err) {
    throw new CheckpointWriteError(
      `Failed to record ${kind}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  } finally {
    if (jsonlWrites.get(key) === write) jsonlWrites.delete(key)
  }
}

export async function appendRunProgress(runId: string, event: Record<string, unknown>): Promise<void> {
  await appendDurableJsonl(runId, 'progress.jsonl', event)
}

export async function appendRunTelemetry(runId: string, event: Record<string, unknown>): Promise<void> {
  await appendDurableJsonl(runId, 'telemetry.jsonl', event)
}

/** Missing artifacts are empty; checksum failures are logged and do not look like “no progress”. */
export async function readRunArtifactTextLenient(runId: string, kind: string): Promise<string> {
  try {
    return (await getRunArtifactText(runId, kind)) ?? ''
  } catch (error) {
    logger.warn('Run artifact unreadable', {
      runId,
      kind,
      error: error instanceof Error ? error.message : String(error),
    })
    return ''
  }
}
