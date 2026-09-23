import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { threatModels as postgresThreatModels, threats as postgresThreats } from '@/lib/db/schema'
import { threatModels as sqliteThreatModels, threats as sqliteThreats } from '@/lib/db/schema.sqlite'
import { getStorage } from './context'
import { actorRequiresOwnership, getActor } from '@/lib/security/actor'
import { terms } from '@/lib/rag/ranking'

export type ReviewLearningStats = {
  confirmed: number
  rejected: number
  pending: number
  reviewed: number
  precision: number | null
  examplesForNextRun: number
}

export type ReviewThreatExample = {
  id: string
  sourceRunId: string
  title: string
  component: string | null
  strideCategory: string | null
  description: string
  impact: string | null
  mitigation: string | null
  severity: string | null
  reviewStatus: 'confirmed' | 'rejected'
  reviewNotes: string | null
  reviewedAt: Date | null
}

const REVIEWED = ['confirmed', 'rejected'] as const
const MAX_REVIEWED_RUNS = 100

function toReviewExample(row: {
  id: string
  threatModelId: string
  title: string
  component: string | null
  strideCategory: string | null
  description: string
  impact: string | null
  mitigation: string | null
  severity: string | null
  reviewStatus: string | null
  reviewNotes: string | null
  userComments: string | null
  reviewedAt: Date | null
}): ReviewThreatExample {
  return {
    id: row.id,
    sourceRunId: row.threatModelId,
    title: row.title,
    component: row.component,
    strideCategory: row.strideCategory,
    description: row.description,
    impact: row.impact,
    mitigation: row.mitigation,
    severity: row.severity,
    reviewStatus: row.reviewStatus === 'rejected' ? 'rejected' : 'confirmed',
    reviewNotes: row.reviewNotes ?? row.userComments,
    reviewedAt: row.reviewedAt,
  }
}

/** A run contributes history only after every persisted finding has a decision. */
async function eligibleReviewedRunIds(systemId: string, excludeRunId?: string): Promise<string[]> {
  if (!systemId.trim()) return []
  const storage = await getStorage()
  const rows = storage.kind === 'sqlite'
    ? await storage.db.select({
        id: sqliteThreatModels.id,
        createdAt: sqliteThreatModels.createdAt,
        totalThreats: sqliteThreatModels.totalThreats,
        stored: sql<number>`cast(count(${sqliteThreats.id}) as integer)`,
        reviewed: sql<number>`cast(count(${sqliteThreats.id}) filter (where ${sqliteThreats.reviewStatus} in ('confirmed', 'rejected') and length(trim(coalesce(${sqliteThreats.reviewNotes}, ${sqliteThreats.userComments}, ''))) > 0) as integer)`,
      }).from(sqliteThreatModels)
        .leftJoin(sqliteThreats, eq(sqliteThreats.threatModelId, sqliteThreatModels.id))
        .where(and(
          eq(sqliteThreatModels.systemId, systemId),
          eq(sqliteThreatModels.status, 'completed'),
          isNull(sqliteThreatModels.archivedAt),
          excludeRunId ? sql`${sqliteThreatModels.id} <> ${excludeRunId}` : undefined,
        ))
        .groupBy(sqliteThreatModels.id, sqliteThreatModels.createdAt, sqliteThreatModels.totalThreats)
    : await (() => {
        const actor = getActor()
        return storage.db.select({
          id: postgresThreatModels.id,
          createdAt: postgresThreatModels.createdAt,
          totalThreats: postgresThreatModels.totalThreats,
          stored: sql<number>`cast(count(${postgresThreats.id}) as integer)`,
          reviewed: sql<number>`cast(count(${postgresThreats.id}) filter (where ${postgresThreats.reviewStatus} in ('confirmed', 'rejected') and length(trim(coalesce(${postgresThreats.reviewNotes}, ${postgresThreats.userComments}, ''))) > 0) as integer)`,
        }).from(postgresThreatModels)
          .leftJoin(postgresThreats, eq(postgresThreats.threatModelId, postgresThreatModels.id))
          .where(and(
            eq(postgresThreatModels.systemId, systemId),
            eq(postgresThreatModels.status, 'completed'),
            isNull(postgresThreatModels.archivedAt),
            excludeRunId ? sql`${postgresThreatModels.id} <> ${excludeRunId}` : undefined,
            actorRequiresOwnership(actor)
              ? sql`${postgresThreatModels.metadata}->>'createdBy' = ${actor!.id}`
              : undefined,
          ))
          .groupBy(postgresThreatModels.id, postgresThreatModels.createdAt, postgresThreatModels.totalThreats)
      })()
  return rows.filter(row => row.stored > 0
    && row.stored === row.reviewed
    && (row.totalThreats === null || row.totalThreats === row.stored))
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, MAX_REVIEWED_RUNS)
    .map(row => row.id)
}

export async function getLearningStats(systemId?: string): Promise<ReviewLearningStats> {
  const storage = await getStorage()
  const aggregates = {
    confirmed: sql<number>`cast(count(*) filter (where ${storage.kind === 'sqlite' ? sqliteThreats.reviewStatus : postgresThreats.reviewStatus} = 'confirmed') as integer)`,
    rejected: sql<number>`cast(count(*) filter (where ${storage.kind === 'sqlite' ? sqliteThreats.reviewStatus : postgresThreats.reviewStatus} = 'rejected') as integer)`,
  }
  let confirmed: number
  let rejected: number
  if (storage.kind === 'sqlite') {
    const [row] = await storage.db.select(aggregates).from(sqliteThreats)
    confirmed = row?.confirmed ?? 0
    rejected = row?.rejected ?? 0
  } else {
    const actor = getActor()
    const query = storage.db.select(aggregates).from(postgresThreats)
      .innerJoin(postgresThreatModels, eq(postgresThreats.threatModelId, postgresThreatModels.id))
    const [row] = actorRequiresOwnership(actor)
      ? await query.where(sql`${postgresThreatModels.metadata}->>'createdBy' = ${actor!.id}`)
      : await query
    confirmed = row?.confirmed ?? 0
    rejected = row?.rejected ?? 0
  }

  // Some legacy runs have a trustworthy `totalThreats` checkpoint but predate
  // persisted threat rows. When newer runs were deleted, counting only rows in
  // `threats` made the visible review backlog incorrectly fall to zero. Use
  // detailed review states when present and the run checkpoint as the fallback.
  const pendingRows = storage.kind === 'sqlite'
    ? await storage.db
        .select({
          totalThreats: sqliteThreatModels.totalThreats,
          storedThreats: sql<number>`cast(count(${sqliteThreats.id}) as integer)`,
          pendingThreats: sql<number>`cast(count(${sqliteThreats.id}) filter (where ${sqliteThreats.reviewStatus} is null or ${sqliteThreats.reviewStatus} not in ('confirmed', 'rejected')) as integer)`,
        })
        .from(sqliteThreatModels)
        .leftJoin(sqliteThreats, eq(sqliteThreats.threatModelId, sqliteThreatModels.id))
        .where(and(
          isNull(sqliteThreatModels.archivedAt),
          inArray(sqliteThreatModels.status, ['completed', 'partial']),
        ))
        .groupBy(sqliteThreatModels.id, sqliteThreatModels.totalThreats)
    : await (() => {
        const actor = getActor()
        return storage.db
          .select({
            totalThreats: postgresThreatModels.totalThreats,
            storedThreats: sql<number>`cast(count(${postgresThreats.id}) as integer)`,
            pendingThreats: sql<number>`cast(count(${postgresThreats.id}) filter (where ${postgresThreats.reviewStatus} is null or ${postgresThreats.reviewStatus} not in ('confirmed', 'rejected')) as integer)`,
          })
          .from(postgresThreatModels)
          .leftJoin(postgresThreats, eq(postgresThreats.threatModelId, postgresThreatModels.id))
          .where(and(
            isNull(postgresThreatModels.archivedAt),
            inArray(postgresThreatModels.status, ['completed', 'partial']),
            actorRequiresOwnership(actor)
              ? sql`${postgresThreatModels.metadata}->>'createdBy' = ${actor!.id}`
              : undefined,
          ))
          .groupBy(postgresThreatModels.id, postgresThreatModels.totalThreats)
      })()
  const pending = pendingRows.reduce(
    (sum, row) => sum + (row.storedThreats > 0 ? row.pendingThreats : (row.totalThreats ?? 0)),
    0,
  )
  const reviewed = confirmed + rejected
  const precision = reviewed > 0 ? confirmed / reviewed : null
  const eligible = systemId ? await countReviewExamplesUsed(systemId) : { confirmed: 0, rejected: 0 }
  const examplesForNextRun = eligible.confirmed + eligible.rejected

  return { confirmed, rejected, pending, reviewed, precision, examplesForNextRun }
}

export async function getConfirmedThreatExamples(systemId: string, limit = 5, excludeRunId?: string): Promise<ReviewThreatExample[]> {
  const runIds = await eligibleReviewedRunIds(systemId, excludeRunId)
  if (!runIds.length) return []
  const storage = await getStorage()
  const rows =
    storage.kind === 'sqlite'
      ? await storage.db
          .select()
          .from(sqliteThreats)
          .where(and(eq(sqliteThreats.reviewStatus, 'confirmed'), inArray(sqliteThreats.threatModelId, runIds)))
          .orderBy(desc(sqliteThreats.reviewedAt), desc(sqliteThreats.createdAt))
          .limit(limit)
      : await (() => {
          const actor = getActor()
          return storage.db.select({ threat: postgresThreats }).from(postgresThreats)
            .innerJoin(postgresThreatModels, eq(postgresThreats.threatModelId, postgresThreatModels.id))
            .where(and(
              eq(postgresThreats.reviewStatus, 'confirmed'),
              inArray(postgresThreats.threatModelId, runIds),
              actorRequiresOwnership(actor)
                ? sql`${postgresThreatModels.metadata}->>'createdBy' = ${actor!.id}`
                : undefined,
            )).orderBy(desc(postgresThreats.reviewedAt), desc(postgresThreats.createdAt))
            .limit(limit).then((joined) => joined.map((row) => row.threat))
        })()

  return rows.map(toReviewExample)
}

export async function getRejectedThreatExamples(systemId: string, limit = 5, excludeRunId?: string): Promise<ReviewThreatExample[]> {
  const runIds = await eligibleReviewedRunIds(systemId, excludeRunId)
  if (!runIds.length) return []
  const storage = await getStorage()
  const rows =
    storage.kind === 'sqlite'
      ? await storage.db
          .select()
          .from(sqliteThreats)
          .where(and(eq(sqliteThreats.reviewStatus, 'rejected'), inArray(sqliteThreats.threatModelId, runIds)))
          .orderBy(desc(sqliteThreats.reviewedAt), desc(sqliteThreats.createdAt))
          .limit(limit)
      : await (() => {
          const actor = getActor()
          return storage.db.select({ threat: postgresThreats }).from(postgresThreats)
            .innerJoin(postgresThreatModels, eq(postgresThreats.threatModelId, postgresThreatModels.id))
            .where(and(
              eq(postgresThreats.reviewStatus, 'rejected'),
              inArray(postgresThreats.threatModelId, runIds),
              actorRequiresOwnership(actor)
                ? sql`${postgresThreatModels.metadata}->>'createdBy' = ${actor!.id}`
                : undefined,
            )).orderBy(desc(postgresThreats.reviewedAt), desc(postgresThreats.createdAt))
            .limit(limit).then((joined) => joined.map((row) => row.threat))
        })()

  return rows.map(toReviewExample)
}

/**
 * Retrieves decisions from fully reviewed, completed runs of this system.
 * No vector re-index is needed when a reviewer changes a decision.
 */
export async function searchReviewedThreatKnowledge(
  query: string,
  systemId: string,
  limit = 5,
  excludeRunId?: string,
): Promise<ReviewThreatExample[]> {
  const runIds = await eligibleReviewedRunIds(systemId, excludeRunId)
  if (!runIds.length) return []
  const storage = await getStorage()
  const reviewedStatuses = [...REVIEWED]
  const tokens = [...new Set(terms(query))].slice(0, 24)
  if (!tokens.length) return []
  const table = storage.kind === 'sqlite' ? sqliteThreats : postgresThreats
  const haystack = sql`lower(coalesce(${table.title}, '') || ' ' || coalesce(${table.component}, '') || ' ' || coalesce(${table.description}, '') || ' ' || coalesce(${table.reviewNotes}, ''))`
  const relevance = sql<number>`(${sql.join(tokens.map(token => sql`case when ${haystack} like ${`%${token}%`} then 1 else 0 end`), sql` + `)})`

  const rows = storage.kind === 'sqlite'
    ? await storage.db
        .select()
        .from(sqliteThreats)
        .where(and(inArray(sqliteThreats.reviewStatus, reviewedStatuses), inArray(sqliteThreats.threatModelId, runIds), sql`${relevance} > 0`))
        .orderBy(desc(relevance), desc(sqliteThreats.reviewedAt))
        .limit(100)
    : await (() => {
        const actor = getActor()
        return storage.db.select({ threat: postgresThreats }).from(postgresThreats)
          .innerJoin(postgresThreatModels, eq(postgresThreats.threatModelId, postgresThreatModels.id))
          .where(and(
            inArray(postgresThreats.reviewStatus, reviewedStatuses),
            inArray(postgresThreats.threatModelId, runIds),
            sql`${relevance} > 0`,
            actorRequiresOwnership(actor)
              ? sql`${postgresThreatModels.metadata}->>'createdBy' = ${actor!.id}`
              : undefined,
          ))
          .orderBy(desc(relevance), desc(postgresThreats.reviewedAt)).limit(100)
          .then((joined) => joined.map((row) => row.threat))
      })()


  return rows
    .map((row) => {
      const example = toReviewExample(row)
      const haystack = [
        example.title,
        example.component,
        example.strideCategory,
        example.description,
        example.impact,
        example.mitigation,
        example.reviewNotes,
      ].filter(Boolean).join(' ').toLowerCase()
      const score = tokens.reduce((hits, token) => hits + (haystack.includes(token) ? 1 : 0), 0) / tokens.length
      return { example, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(limit, 10)))
    .map(({ example }) => example)
}

export async function countReviewExamplesUsed(systemId: string, excludeRunId?: string): Promise<{ confirmed: number; rejected: number }> {
  const confirmed = await getConfirmedThreatExamples(systemId, 5, excludeRunId)
  const rejected = await getRejectedThreatExamples(systemId, 5, excludeRunId)
  return { confirmed: confirmed.length, rejected: rejected.length }
}
