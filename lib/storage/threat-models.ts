import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { isTerminalAnalysisStatus, TERMINAL_ANALYSIS_STATUSES } from '@/lib/models/analysis-status'
import { threatModels as postgresThreatModels, threats as postgresThreats } from '@/lib/db/schema'
import type {
  ThreatModel as PostgresThreatModel,
  Threat as PostgresThreat,
  NewThreatModel as PostgresNewThreatModel,
  NewThreat as PostgresNewThreat,
} from '@/lib/db/schema'
import { threatModels as sqliteThreatModels, threats as sqliteThreats } from '@/lib/db/schema.sqlite'
import { getStorage } from './context'
import { PIPELINE_LEASE_TTL_MS, leaseExpiryFrom } from '@/lib/pipeline/lease'
import {
  actorCanAccess,
  actorRequiresOwnership,
  createdByFromMetadata,
  getActor,
  withCreatedBy,
} from '@/lib/security/actor'

export type AnalysisStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed'

export type ThreatModelSummary = {
  id: string
  systemName: string | null
  status: AnalysisStatus
  totalThreats: number | null
  filteredThreats: number | null
  durationSeconds: number | null
  externalId: string | null
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
  archivedAt: Date | null
  pipelineErrors: string[] | null
  isDemo: boolean
}

export type ThreatModelQuery = {
  page: number
  limit: number
  status?: AnalysisStatus | null
  archived?: boolean
}

export type StoredThreatModel = PostgresThreatModel
export type StoredThreat = PostgresThreat

export type ThreatUpdate = {
  description?: string
  strideCategory?: string | null
  dreadDamage?: number
  dreadReproducibility?: number
  dreadExploitability?: number
  dreadAffectedUsers?: number
  dreadDiscoverability?: number
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  reviewStatus?: string | null
  reviewNotes?: string | null
  reviewedAt?: Date
  userComments?: string
}

function normalizeSqliteThreatModel(row: typeof sqliteThreatModels.$inferSelect): StoredThreatModel {
  return {
    ...row,
    supportingDocuments: row.supportingDocuments ?? null,
    metadata: (row.metadata ?? null) as StoredThreatModel['metadata'],
    architectureJson: (row.architectureJson ?? null) as StoredThreatModel['architectureJson'],
    methodologiesUsed: row.methodologiesUsed ?? null,
    pipelineErrors: row.pipelineErrors ?? null,
    webhookDelivered: row.webhookDelivered ?? false,
  } as StoredThreatModel
}

function normalizeSqliteThreat(row: typeof sqliteThreats.$inferSelect): StoredThreat {
  return {
    ...row,
    attackScenarios: row.attackScenarios ?? null,
    recommendedControls: row.recommendedControls ?? null,
    owaspCategories: row.owaspCategories ?? null,
    evidenceSources: (row.evidenceSources ?? null) as StoredThreat['evidenceSources'],
    methodologyData: (row.methodologyData ?? null) as StoredThreat['methodologyData'],
    traceability: (row.traceability ?? null) as StoredThreat['traceability'],
  } as StoredThreat
}

function ownerConstraint() {
  const actor = getActor()
  if (!actorRequiresOwnership(actor) || !actor) return undefined
  return actor.id
}

export async function listThreatModels(query: ThreatModelQuery): Promise<ThreatModelSummary[]> {
  const offset = (query.page - 1) * query.limit
  const storage = getStorage()

  if (storage.kind === 'sqlite') {
    const statusFilter = query.status ? eq(sqliteThreatModels.status, query.status) : undefined
    const archiveFilter = query.archived
      ? isNotNull(sqliteThreatModels.archivedAt)
      : isNull(sqliteThreatModels.archivedAt)
    const owner = ownerConstraint()
    const ownerFilter = owner
      ? sql`json_extract(${sqliteThreatModels.metadata}, '$.createdBy') = ${owner}`
      : undefined
    const rows = await storage.db
      .select({
        id: sqliteThreatModels.id,
        systemName: sqliteThreatModels.title,
        status: sqliteThreatModels.status,
        totalThreats: sqliteThreatModels.totalThreats,
        filteredThreats: sqliteThreatModels.filteredThreats,
        durationSeconds: sqliteThreatModels.executionTimeSeconds,
        externalId: sqliteThreatModels.externalId,
        createdAt: sqliteThreatModels.createdAt,
        startedAt: sqliteThreatModels.startedAt,
        completedAt: sqliteThreatModels.completedAt,
        archivedAt: sqliteThreatModels.archivedAt,
        pipelineErrors: sqliteThreatModels.pipelineErrors,
        metadata: sqliteThreatModels.metadata,
      })
      .from(sqliteThreatModels)
      .where(and(statusFilter, archiveFilter, ownerFilter))
      .orderBy(desc(sqliteThreatModels.createdAt), desc(sqliteThreatModels.id))
      .limit(query.limit)
      .offset(offset)

    return rows.map(({ metadata, ...row }) => ({
      ...row,
      status: row.status as AnalysisStatus,
      isDemo: metadata?.demo === true,
    }))
  }

  const statusFilter = query.status ? eq(postgresThreatModels.status, query.status) : undefined
  const archiveFilter = query.archived
    ? isNotNull(postgresThreatModels.archivedAt)
    : isNull(postgresThreatModels.archivedAt)
  const owner = ownerConstraint()
  const ownerFilter = owner
    ? sql`${postgresThreatModels.metadata}->>'createdBy' = ${owner}`
    : undefined
  const rows = await storage.db
    .select({
      id: postgresThreatModels.id,
      systemName: postgresThreatModels.title,
      status: postgresThreatModels.status,
      totalThreats: postgresThreatModels.totalThreats,
      filteredThreats: postgresThreatModels.filteredThreats,
      durationSeconds: postgresThreatModels.executionTimeSeconds,
      externalId: postgresThreatModels.externalId,
      createdAt: postgresThreatModels.createdAt,
      startedAt: postgresThreatModels.startedAt,
      completedAt: postgresThreatModels.completedAt,
      archivedAt: postgresThreatModels.archivedAt,
      pipelineErrors: postgresThreatModels.pipelineErrors,
      metadata: postgresThreatModels.metadata,
    })
    .from(postgresThreatModels)
    .where(and(statusFilter, archiveFilter, ownerFilter))
    .orderBy(desc(postgresThreatModels.createdAt), desc(postgresThreatModels.id))
    .limit(query.limit)
    .offset(offset)

  return rows.map(({ metadata, ...row }) => ({
    ...row,
    status: row.status as AnalysisStatus,
    isDemo: metadata?.demo === true,
  }))
}

export async function getThreatModel(id: string): Promise<StoredThreatModel | null> {
  const storage = getStorage()
  if (storage.kind === 'sqlite') {
    const [row] = await storage.db
      .select()
      .from(sqliteThreatModels)
      .where(eq(sqliteThreatModels.id, id))
      .limit(1)
    return row && actorCanAccess(createdByFromMetadata(row.metadata))
      ? normalizeSqliteThreatModel(row)
      : null
  }

  const [row] = await storage.db
    .select()
    .from(postgresThreatModels)
    .where(eq(postgresThreatModels.id, id))
    .limit(1)
  if (!row || !actorCanAccess(createdByFromMetadata(row.metadata))) return null
  return row
}

/** Lightweight poll for SSE stream — avoids loading large json blobs each interval. */
export async function getThreatModelPollSnapshot(id: string): Promise<{
  id: string
  status: string
  totalThreats: number | null
  executionTimeSeconds: number | null
  errorMessage: string | null
  cancelRequestedAt: Date | null
} | null> {
  const storage = getStorage()
  if (storage.kind === 'sqlite') {
    const [row] = await storage.db
      .select({
        id: sqliteThreatModels.id,
        status: sqliteThreatModels.status,
        totalThreats: sqliteThreatModels.totalThreats,
        executionTimeSeconds: sqliteThreatModels.executionTimeSeconds,
        errorMessage: sqliteThreatModels.errorMessage,
        cancelRequestedAt: sqliteThreatModels.cancelRequestedAt,
        metadata: sqliteThreatModels.metadata,
      })
      .from(sqliteThreatModels)
      .where(eq(sqliteThreatModels.id, id))
      .limit(1)
    if (!row || !actorCanAccess(createdByFromMetadata(row.metadata))) return null
    return {
      id: row.id,
      status: row.status,
      totalThreats: row.totalThreats,
      executionTimeSeconds: row.executionTimeSeconds,
      errorMessage: row.errorMessage,
      cancelRequestedAt: row.cancelRequestedAt ?? null,
    }
  }

  const [row] = await storage.db
    .select({
      id: postgresThreatModels.id,
      status: postgresThreatModels.status,
      totalThreats: postgresThreatModels.totalThreats,
      executionTimeSeconds: postgresThreatModels.executionTimeSeconds,
      errorMessage: postgresThreatModels.errorMessage,
      cancelRequestedAt: postgresThreatModels.cancelRequestedAt,
      metadata: postgresThreatModels.metadata,
    })
    .from(postgresThreatModels)
    .where(eq(postgresThreatModels.id, id))
    .limit(1)
  if (!row || !actorCanAccess(createdByFromMetadata(row.metadata))) return null
  return {
    id: row.id,
    status: row.status,
    totalThreats: row.totalThreats,
    executionTimeSeconds: row.executionTimeSeconds,
    errorMessage: row.errorMessage,
    cancelRequestedAt: row.cancelRequestedAt ?? null,
  }
}

export async function listThreats(threatModelId: string): Promise<StoredThreat[]> {
  const storage = getStorage()
  if (storage.kind === 'sqlite') {
    const rows = await storage.db
      .select()
      .from(sqliteThreats)
      .where(eq(sqliteThreats.threatModelId, threatModelId))
      .orderBy(asc(sqliteThreats.createdAt), asc(sqliteThreats.id))
    return rows.map(normalizeSqliteThreat)
  }

  return storage.db
    .select()
    .from(postgresThreats)
    .where(eq(postgresThreats.threatModelId, threatModelId))
    .orderBy(asc(postgresThreats.createdAt), asc(postgresThreats.id))
}

/**
 * A run that degraded still ended. Spelling the terminal statuses out here let
 * `partial` drift out of the archive filter while delete accepted it, so those
 * runs piled up in the queue with no way to clear them. The shared list is the
 * single source of truth for both.
 */
export async function archiveThreatModel(id: string): Promise<boolean> {
  const storage = getStorage()
  const now = new Date()
  if (storage.kind === 'sqlite') {
    const [row] = await storage.db
      .update(sqliteThreatModels)
      .set({ archivedAt: now, updatedAt: now })
      .where(and(
        eq(sqliteThreatModels.id, id),
        isNull(sqliteThreatModels.archivedAt),
        inArray(sqliteThreatModels.status, [...TERMINAL_ANALYSIS_STATUSES]),
      ))
      .returning({ id: sqliteThreatModels.id })
    return Boolean(row)
  }

  const [row] = await storage.db
    .update(postgresThreatModels)
    .set({ archivedAt: now, updatedAt: now })
    .where(and(
      eq(postgresThreatModels.id, id),
      isNull(postgresThreatModels.archivedAt),
      inArray(postgresThreatModels.status, [...TERMINAL_ANALYSIS_STATUSES]),
    ))
    .returning({ id: postgresThreatModels.id })
  return Boolean(row)
}

export async function renameThreatModel(id: string, title: string): Promise<boolean> {
  const existing = await getThreatModel(id)
  if (!existing) return false

  const storage = getStorage()
  const now = new Date()
  if (storage.kind === 'sqlite') {
    const [row] = await storage.db
      .update(sqliteThreatModels)
      .set({ title, updatedAt: now })
      .where(eq(sqliteThreatModels.id, id))
      .returning({ id: sqliteThreatModels.id })
    return Boolean(row)
  }

  const [row] = await storage.db
    .update(postgresThreatModels)
    .set({ title, updatedAt: now })
    .where(eq(postgresThreatModels.id, id))
    .returning({ id: postgresThreatModels.id })
  return Boolean(row)
}

export async function restoreThreatModel(id: string): Promise<boolean> {
  const storage = getStorage()
  const now = new Date()
  if (storage.kind === 'sqlite') {
    const [row] = await storage.db
      .update(sqliteThreatModels)
      .set({ archivedAt: null, updatedAt: now })
      .where(and(eq(sqliteThreatModels.id, id), isNotNull(sqliteThreatModels.archivedAt)))
      .returning({ id: sqliteThreatModels.id })
    return Boolean(row)
  }

  const [row] = await storage.db
    .update(postgresThreatModels)
    .set({ archivedAt: null, updatedAt: now })
    .where(and(eq(postgresThreatModels.id, id), isNotNull(postgresThreatModels.archivedAt)))
    .returning({ id: postgresThreatModels.id })
  return Boolean(row)
}

export async function permanentlyDeleteThreatModel(id: string): Promise<StoredThreatModel | null> {
  const existing = await getThreatModel(id)
  if (!existing || !isTerminalAnalysisStatus(existing.status)) return null

  const storage = getStorage()
  if (storage.kind === 'sqlite') {
    const [row] = await storage.db
      .delete(sqliteThreatModels)
      .where(eq(sqliteThreatModels.id, id))
      .returning()
    return row ? normalizeSqliteThreatModel(row) : null
  }

  const [row] = await storage.db
    .delete(postgresThreatModels)
    .where(eq(postgresThreatModels.id, id))
    .returning()
  return row ?? null
}

export async function getThreat(threatModelId: string, threatId: string): Promise<StoredThreat | null> {
  const storage = getStorage()
  if (storage.kind === 'sqlite') {
    const [row] = await storage.db
      .select()
      .from(sqliteThreats)
      .where(and(eq(sqliteThreats.threatModelId, threatModelId), eq(sqliteThreats.id, threatId)))
      .limit(1)
    return row ? normalizeSqliteThreat(row) : null
  }

  const [row] = await storage.db
    .select()
    .from(postgresThreats)
    .where(and(eq(postgresThreats.threatModelId, threatModelId), eq(postgresThreats.id, threatId)))
    .limit(1)
  return row ?? null
}

export async function updateThreat(
  threatModelId: string,
  threatId: string,
  update: ThreatUpdate,
): Promise<StoredThreat | null> {
  const storage = getStorage()
  if (storage.kind === 'sqlite') {
    const [row] = await storage.db
      .update(sqliteThreats)
      .set(update)
      .where(and(eq(sqliteThreats.threatModelId, threatModelId), eq(sqliteThreats.id, threatId)))
      .returning()
    return row ? normalizeSqliteThreat(row) : null
  }

  const [row] = await storage.db
    .update(postgresThreats)
    .set(update)
    .where(and(eq(postgresThreats.threatModelId, threatModelId), eq(postgresThreats.id, threatId)))
    .returning()
  return row ?? null
}

export async function requestThreatModelCancellation(id: string): Promise<boolean> {
  const storage = getStorage()
  const now = new Date()
  if (storage.kind === 'sqlite') {
    const rows = await storage.db
      .update(sqliteThreatModels)
      .set({
        status: 'failed',
        errorMessage: 'Stopped by user',
        completedAt: now,
        cancelRequestedAt: now,
        cancelGeneration: sql`${sqliteThreatModels.cancelGeneration} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(sqliteThreatModels.id, id),
          sql`${sqliteThreatModels.status} IN ('pending', 'running')`,
          sql`${sqliteThreatModels.cancelRequestedAt} IS NULL`,
        ),
      )
      .returning({ id: sqliteThreatModels.id })
    return rows.length === 1
  }

  const rows = await storage.db
    .update(postgresThreatModels)
    .set({
      status: 'failed',
      errorMessage: 'Stopped by user',
      completedAt: now,
      cancelRequestedAt: now,
      cancelGeneration: sql`${postgresThreatModels.cancelGeneration} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(postgresThreatModels.id, id),
        sql`${postgresThreatModels.status} IN ('pending', 'running')`,
        sql`${postgresThreatModels.cancelRequestedAt} IS NULL`,
      ),
    )
    .returning({ id: postgresThreatModels.id })
  return rows.length === 1
}

export async function createThreatModel(
  values: PostgresNewThreatModel,
): Promise<StoredThreatModel> {
  const stamped = { ...values, metadata: withCreatedBy(values.metadata ?? {}) }
  const storage = getStorage()
  if (storage.kind === 'sqlite') {
    const [row] = await storage.db
      .insert(sqliteThreatModels)
      .values(stamped as typeof sqliteThreatModels.$inferInsert)
      .returning()
    if (!row) throw new Error('Failed to create threat model record')
    return normalizeSqliteThreatModel(row)
  }

  const [row] = await storage.db.insert(postgresThreatModels).values(stamped).returning()
  if (!row) throw new Error('Failed to create threat model record')
  return row
}

/**
 * Records a degraded phase while the run is still going. Pipeline errors used to
 * be written only on successful completion, so a run that timed out reported
 * nothing about the analysts that had already failed inside it.
 */
export async function appendPipelineError(id: string, message: string): Promise<void> {
  const storage = getStorage()
  const now = new Date()

  if (storage.kind === 'sqlite') {
    const [current] = await storage.db
      .select({ pipelineErrors: sqliteThreatModels.pipelineErrors })
      .from(sqliteThreatModels)
      .where(eq(sqliteThreatModels.id, id))
    const existing = (current?.pipelineErrors as string[] | null) ?? []
    if (existing.includes(message)) return
    await storage.db
      .update(sqliteThreatModels)
      .set({ pipelineErrors: [...existing, message], updatedAt: now })
      .where(eq(sqliteThreatModels.id, id))
    return
  }

  const [current] = await storage.db
    .select({ pipelineErrors: postgresThreatModels.pipelineErrors })
    .from(postgresThreatModels)
    .where(eq(postgresThreatModels.id, id))
  const existing = (current?.pipelineErrors as string[] | null) ?? []
  if (existing.includes(message)) return
  await storage.db
    .update(postgresThreatModels)
    .set({ pipelineErrors: [...existing, message], updatedAt: now })
    .where(eq(postgresThreatModels.id, id))
}

/**
 * Persists the running token count while the pipeline is still going, so a run
 * that times out or is stopped still reports what it spent.
 */
export async function saveTokenUsage(id: string, totalTokens: number): Promise<void> {
  if (totalTokens <= 0) return
  const storage = getStorage()
  const now = new Date()

  if (storage.kind === 'sqlite') {
    await storage.db
      .update(sqliteThreatModels)
      .set({ llmTokensUsed: totalTokens, updatedAt: now })
      .where(eq(sqliteThreatModels.id, id))
    return
  }

  await storage.db
    .update(postgresThreatModels)
    .set({ llmTokensUsed: totalTokens, updatedAt: now })
    .where(eq(postgresThreatModels.id, id))
}

/**
 * Persists the parsed architecture the moment the parser finishes, so a run that
 * later times out or is stopped still shows its diagram and component inventory
 * instead of discarding a phase that already burned tokens.
 */
export async function saveArchitectureCheckpoint(
  id: string,
  architectureJson: unknown,
): Promise<void> {
  const storage = getStorage()
  const now = new Date()

  if (storage.kind === 'sqlite') {
    await storage.db
      .update(sqliteThreatModels)
      .set({ architectureJson, updatedAt: now })
      .where(and(eq(sqliteThreatModels.id, id), eq(sqliteThreatModels.status, 'running')))
    return
  }

  await storage.db
    .update(postgresThreatModels)
    .set({
      architectureJson: architectureJson as PostgresThreatModel['architectureJson'],
      updatedAt: now,
    })
    .where(and(eq(postgresThreatModels.id, id), eq(postgresThreatModels.status, 'running')))
}

function sqliteClaimable(now: Date) {
  return and(
    isNull(sqliteThreatModels.cancelRequestedAt),
    or(
      eq(sqliteThreatModels.status, 'pending'),
      and(
        eq(sqliteThreatModels.status, 'running'),
        or(isNull(sqliteThreatModels.leaseExpiresAt), lt(sqliteThreatModels.leaseExpiresAt, now)),
      ),
    ),
  )
}

function postgresClaimable(now: Date) {
  return and(
    isNull(postgresThreatModels.cancelRequestedAt),
    or(
      eq(postgresThreatModels.status, 'pending'),
      and(
        eq(postgresThreatModels.status, 'running'),
        or(isNull(postgresThreatModels.leaseExpiresAt), lt(postgresThreatModels.leaseExpiresAt, now)),
      ),
    ),
  )
}

function claimAssignment(workerInstanceId: string, now: Date) {
  return {
    status: 'running' as const,
    workerInstanceId,
    workerHeartbeatAt: now,
    leaseExpiresAt: leaseExpiryFrom(now),
    updatedAt: now,
  }
}

export async function claimThreatModelRun(
  id: string,
  workerInstanceId: string,
): Promise<boolean> {
  const storage = getStorage()
  const now = new Date()
  const assignment = claimAssignment(workerInstanceId, now)
  if (storage.kind === 'sqlite') {
    const rows = await storage.db
      .update(sqliteThreatModels)
      .set({
        ...assignment,
        startedAt: sql`coalesce(${sqliteThreatModels.startedAt}, ${now.getTime()})`,
      })
      .where(and(eq(sqliteThreatModels.id, id), sqliteClaimable(now)))
      .returning({ id: sqliteThreatModels.id })
    return rows.length === 1
  }

  const rows = await storage.db
    .update(postgresThreatModels)
    .set({
      ...assignment,
      startedAt: sql`coalesce(${postgresThreatModels.startedAt}, ${now})`,
    })
    .where(and(eq(postgresThreatModels.id, id), postgresClaimable(now)))
    .returning({ id: postgresThreatModels.id })
  return rows.length === 1
}

/** Atomically take the next pending or expired run. Two workers cannot share an id. */
export async function claimNextThreatModelRun(
  workerInstanceId: string,
): Promise<string | null> {
  const storage = getStorage()
  const now = new Date()
  const assignment = claimAssignment(workerInstanceId, now)
  if (storage.kind === 'sqlite') {
    const nowMs = now.getTime()
    const leaseMs = leaseExpiryFrom(now).getTime()
    const row = storage.db.$client.prepare(`
      UPDATE threat_models
      SET
        status = 'running',
        worker_instance_id = ?,
        worker_heartbeat_at = ?,
        lease_expires_at = ?,
        updated_at = ?,
        started_at = coalesce(started_at, ?)
      WHERE id = (
        SELECT id FROM threat_models
        WHERE cancel_requested_at IS NULL
          AND (
            status = 'pending'
            OR (
              status = 'running'
              AND (lease_expires_at IS NULL OR lease_expires_at < ?)
            )
          )
        ORDER BY queued_at ASC
        LIMIT 1
      )
      RETURNING id
    `).get(workerInstanceId, nowMs, leaseMs, nowMs, nowMs, nowMs) as { id: string } | undefined
    return row?.id ?? null
  }

  return storage.db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: postgresThreatModels.id })
      .from(postgresThreatModels)
      .where(postgresClaimable(now))
      .orderBy(asc(postgresThreatModels.queuedAt))
      .limit(1)
      .for('update', { skipLocked: true })
    if (!candidate) return null
    const rows = await tx
      .update(postgresThreatModels)
      .set({
        ...assignment,
        startedAt: sql`coalesce(${postgresThreatModels.startedAt}, ${now})`,
      })
      .where(and(eq(postgresThreatModels.id, candidate.id), postgresClaimable(now)))
      .returning({ id: postgresThreatModels.id })
    return rows[0]?.id ?? null
  })
}

export type ThreatModelCompletion = {
  ragTrace?: import('@/lib/rag/trace').RAGTraceSnapshot
  systemDescription: string | null
  debateSummary: string | null
  methodologiesUsed: string[]
  architectureJson: unknown
  totalThreats: number
  filteredThreats: number
  executionTimeSeconds: number
  llmTokensUsed?: number | null
  pipelineErrors: string[] | null
  currentPhase: string
  /** Worker that must still own the lease to publish this terminal state. */
  workerInstanceId: string
  /** `partial` when a phase degraded on the way; the run is still readable. */
  status?: Extract<AnalysisStatus, 'completed' | 'partial'>
}

export async function completeThreatModelRun(
  id: string,
  completion: ThreatModelCompletion,
  threatsToInsert: PostgresNewThreat[],
): Promise<void> {
  const storage = getStorage()
  const now = new Date()
  const finalStatus = completion.status ?? 'completed'

  if (storage.kind === 'sqlite') {
    storage.db.transaction((tx) => {
      const completed = tx
        .update(sqliteThreatModels)
        .set({
          status: finalStatus,
          systemDescription: completion.systemDescription,
          debateSummary: completion.debateSummary,
          methodologiesUsed: completion.methodologiesUsed,
          architectureJson: completion.architectureJson,
          totalThreats: completion.totalThreats,
          filteredThreats: completion.filteredThreats,
          executionTimeSeconds: completion.executionTimeSeconds,
          llmTokensUsed: completion.llmTokensUsed ?? null,
          completedAt: now,
          updatedAt: now,
          pipelineErrors: completion.pipelineErrors,
          currentPhase: completion.currentPhase,
        })
        .where(
          and(
            eq(sqliteThreatModels.id, id),
            eq(sqliteThreatModels.status, 'running'),
            eq(sqliteThreatModels.workerInstanceId, completion.workerInstanceId),
            isNull(sqliteThreatModels.cancelRequestedAt),
          ),
        )
        .returning({ id: sqliteThreatModels.id })
        .all()

      if (completed.length !== 1) {
        throw new Error('Pipeline completion was superseded by cancellation or lease loss')
      }

      if (threatsToInsert.length > 0) {
        tx.insert(sqliteThreats)
          .values(threatsToInsert as Array<typeof sqliteThreats.$inferInsert>)
          .run()
      }
    })
    return
  }

  await storage.db.transaction(async (tx) => {
    const completed = await tx
      .update(postgresThreatModels)
      .set({
        status: finalStatus,
        systemDescription: completion.systemDescription,
        debateSummary: completion.debateSummary,
        methodologiesUsed: completion.methodologiesUsed,
        architectureJson: completion.architectureJson as PostgresThreatModel['architectureJson'],
        totalThreats: completion.totalThreats,
        filteredThreats: completion.filteredThreats,
        executionTimeSeconds: completion.executionTimeSeconds,
        llmTokensUsed: completion.llmTokensUsed ?? null,
        completedAt: now,
        updatedAt: now,
        pipelineErrors: completion.pipelineErrors,
        currentPhase: completion.currentPhase,
        ...(completion.ragTrace ? { metadata: sql`coalesce(${postgresThreatModels.metadata}, '{}'::jsonb) || ${JSON.stringify({ rag_trace: completion.ragTrace })}::jsonb` } : {}),
      })
      .where(
        and(
          eq(postgresThreatModels.id, id),
          eq(postgresThreatModels.status, 'running'),
          eq(postgresThreatModels.workerInstanceId, completion.workerInstanceId),
          isNull(postgresThreatModels.cancelRequestedAt),
        ),
      )
      .returning({ id: postgresThreatModels.id })

    if (completed.length !== 1) {
      throw new Error('Pipeline completion was superseded by cancellation or lease loss')
    }

    if (threatsToInsert.length > 0) {
      await tx.insert(postgresThreats).values(threatsToInsert)
    }
  })
}

export async function failThreatModelRun(
  id: string,
  message: string,
  workerInstanceId: string,
  durationMs?: number,
): Promise<boolean> {
  const storage = getStorage()
  const now = new Date()
  const timing = durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0
    ? { executionTimeSeconds: Math.round(durationMs / 1000) } : {}
  if (storage.kind === 'sqlite') {
    const rows = await storage.db
      .update(sqliteThreatModels)
      .set({ status: 'failed', errorMessage: message, completedAt: now, updatedAt: now, ...timing })
      .where(and(
        eq(sqliteThreatModels.id, id),
        eq(sqliteThreatModels.status, 'running'),
        eq(sqliteThreatModels.workerInstanceId, workerInstanceId),
        isNull(sqliteThreatModels.cancelRequestedAt),
      ))
      .returning({ id: sqliteThreatModels.id })
    return rows.length === 1
  }

  const rows = await storage.db
    .update(postgresThreatModels)
    .set({ status: 'failed', errorMessage: message, completedAt: now, updatedAt: now, ...timing })
    .where(and(
      eq(postgresThreatModels.id, id),
      eq(postgresThreatModels.status, 'running'),
      eq(postgresThreatModels.workerInstanceId, workerInstanceId),
      isNull(postgresThreatModels.cancelRequestedAt),
    ))
    .returning({ id: postgresThreatModels.id })
  return rows.length === 1
}

export async function markWebhookDelivered(id: string): Promise<void> {
  const storage = getStorage()
  if (storage.kind === 'sqlite') {
    await storage.db
      .update(sqliteThreatModels)
      .set({ webhookDelivered: true })
      .where(eq(sqliteThreatModels.id, id))
    return
  }

  await storage.db
    .update(postgresThreatModels)
    .set({ webhookDelivered: true })
    .where(eq(postgresThreatModels.id, id))
}

export async function isThreatModelCancellationRequested(id: string): Promise<boolean> {
  const row = await getThreatModel(id)
  return !row || row.cancelRequestedAt !== null || row.status === 'failed'
}

export async function touchThreatModelHeartbeat(
  id: string,
  workerInstanceId: string,
  currentPhase?: string,
): Promise<boolean> {
  const storage = getStorage()
  const now = new Date()
  const update = {
    workerHeartbeatAt: now,
    leaseExpiresAt: leaseExpiryFrom(now),
    updatedAt: now,
    ...(currentPhase ? { currentPhase } : {}),
  }

  if (storage.kind === 'sqlite') {
    const rows = await storage.db
      .update(sqliteThreatModels)
      .set(update)
      .where(
        and(
          eq(sqliteThreatModels.id, id),
          eq(sqliteThreatModels.status, 'running'),
          eq(sqliteThreatModels.workerInstanceId, workerInstanceId),
          isNull(sqliteThreatModels.cancelRequestedAt),
        ),
      )
      .returning({ id: sqliteThreatModels.id })
    return rows.length === 1
  }

  const rows = await storage.db
    .update(postgresThreatModels)
    .set(update)
    .where(
      and(
        eq(postgresThreatModels.id, id),
        eq(postgresThreatModels.status, 'running'),
        eq(postgresThreatModels.workerInstanceId, workerInstanceId),
        isNull(postgresThreatModels.cancelRequestedAt),
      ),
    )
    .returning({ id: postgresThreatModels.id })
  return rows.length === 1
}

/** Return expired running work to the queue. Do not mark it failed. */
export async function reapStaleThreatModelHeartbeats(
  staleMs = PIPELINE_LEASE_TTL_MS,
): Promise<Array<{ id: string; title: string | null }>> {
  const storage = getStorage()
  const now = new Date()
  const heartbeatThreshold = new Date(now.getTime() - staleMs)
  const update = {
    status: 'pending' as const,
    workerInstanceId: null,
    workerHeartbeatAt: null,
    leaseExpiresAt: null,
    updatedAt: now,
  }

  if (storage.kind === 'sqlite') {
    return storage.db
      .update(sqliteThreatModels)
      .set(update)
      .where(
        and(
          eq(sqliteThreatModels.status, 'running'),
          isNull(sqliteThreatModels.cancelRequestedAt),
          or(
            lt(sqliteThreatModels.leaseExpiresAt, now),
            and(
              isNull(sqliteThreatModels.leaseExpiresAt),
              or(
                isNull(sqliteThreatModels.workerHeartbeatAt),
                lt(sqliteThreatModels.workerHeartbeatAt, heartbeatThreshold),
              ),
            ),
          ),
        ),
      )
      .returning({ id: sqliteThreatModels.id, title: sqliteThreatModels.title })
  }

  return storage.db
    .update(postgresThreatModels)
    .set(update)
    .where(
      and(
        eq(postgresThreatModels.status, 'running'),
        isNull(postgresThreatModels.cancelRequestedAt),
        or(
          lt(postgresThreatModels.leaseExpiresAt, now),
          and(
            isNull(postgresThreatModels.leaseExpiresAt),
            or(
              isNull(postgresThreatModels.workerHeartbeatAt),
              lt(postgresThreatModels.workerHeartbeatAt, heartbeatThreshold),
            ),
          ),
        ),
      ),
    )
    .returning({ id: postgresThreatModels.id, title: postgresThreatModels.title })
}
