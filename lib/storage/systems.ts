import { randomUUID } from 'crypto'
import { desc, eq, and, sql } from 'drizzle-orm'
import { systems as postgresSystems, threatModels as postgresThreatModels } from '@/lib/db/schema'
import type { NewSystem as PostgresNewSystem, System as PostgresSystem } from '@/lib/db/schema'
import { systems as sqliteSystems, threatModels as sqliteThreatModels } from '@/lib/db/schema.sqlite'
import { getStorage } from './context'
import {
  actorCanAccess,
  actorRequiresOwnership,
  createdByFromMetadata,
  getActor,
  withCreatedBy,
} from '@/lib/security/actor'

export type StoredSystem = PostgresSystem
export type SystemRunSummary = {
  id: string
  title: string | null
  status: string
  versionHash: string
  totalThreats: number | null
  createdAt: Date
  completedAt: Date | null
}

function ownerConstraint() {
  const actor = getActor()
  if (!actorRequiresOwnership(actor) || !actor) return undefined
  return actor.id
}

function generateSystemId(): string {
  return `sys_${randomUUID()}`
}

export async function createSystem(values: {
  name: string
  description?: string | null
  metadata?: Record<string, unknown> | null
}): Promise<StoredSystem> {
  const storage = getStorage()
  const id = generateSystemId()
  const metadata = withCreatedBy(values.metadata ?? {})
  const now = new Date()

  if (storage.kind === 'sqlite') {
    const [row] = await storage.db
      .insert(sqliteSystems)
      .values({
        id,
        name: values.name,
        description: values.description ?? null,
        metadata,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    if (!row) throw new Error('Failed to create system')
    return row as StoredSystem
  }

  const payload: PostgresNewSystem = {
    id,
    name: values.name,
    description: values.description ?? null,
    metadata,
  }
  const [row] = await storage.db.insert(postgresSystems).values(payload).returning()
  if (!row) throw new Error('Failed to create system')
  return row
}

export async function getSystem(id: string): Promise<StoredSystem | null> {
  const storage = getStorage()
  if (storage.kind === 'sqlite') {
    const [row] = await storage.db.select().from(sqliteSystems).where(eq(sqliteSystems.id, id)).limit(1)
    const system = (row as StoredSystem | undefined) ?? null
    if (!system || !actorCanAccess(createdByFromMetadata(system.metadata))) return null
    return system
  }
  const [row] = await storage.db.select().from(postgresSystems).where(eq(postgresSystems.id, id)).limit(1)
  if (!row || !actorCanAccess(createdByFromMetadata(row.metadata))) return null
  return row
}

export async function listSystems(limit = 50): Promise<StoredSystem[]> {
  const storage = getStorage()
  const owner = ownerConstraint()
  if (storage.kind === 'sqlite') {
    const ownerFilter = owner
      ? sql`json_extract(${sqliteSystems.metadata}, '$.createdBy') = ${owner}`
      : undefined
    const rows = await storage.db
      .select()
      .from(sqliteSystems)
      .where(ownerFilter)
      .orderBy(desc(sqliteSystems.updatedAt))
      .limit(limit)
    return rows as StoredSystem[]
  }
  const ownerFilter = owner
    ? sql`${postgresSystems.metadata}->>'createdBy' = ${owner}`
    : undefined
  return storage.db
    .select()
    .from(postgresSystems)
    .where(ownerFilter)
    .orderBy(desc(postgresSystems.updatedAt))
    .limit(limit)
}

export async function updateSystem(
  id: string,
  patch: { name?: string; description?: string | null; metadata?: Record<string, unknown> | null },
): Promise<StoredSystem | null> {
  const existing = await getSystem(id)
  if (!existing) return null
  const nextMetadata =
    patch.metadata !== undefined
      ? { ...withCreatedBy(patch.metadata ?? {}), createdBy: createdByFromMetadata(existing.metadata) ?? getActor()?.id }
      : undefined
  const nextPatch = nextMetadata ? { ...patch, metadata: nextMetadata } : patch
  const storage = getStorage()
  const now = new Date()
  if (storage.kind === 'sqlite') {
    const [row] = await storage.db
      .update(sqliteSystems)
      .set({ ...nextPatch, updatedAt: now })
      .where(eq(sqliteSystems.id, id))
      .returning()
    return (row as StoredSystem | undefined) ?? null
  }
  const [row] = await storage.db
    .update(postgresSystems)
    .set({ ...nextPatch, updatedAt: now })
    .where(eq(postgresSystems.id, id))
    .returning()
  return row ?? null
}

export async function findOrCreateSystemByName(
  name: string,
  description?: string | null,
): Promise<StoredSystem> {
  const storage = getStorage()
  const owner = ownerConstraint()
  if (storage.kind === 'sqlite') {
    const ownerFilter = owner
      ? sql`json_extract(${sqliteSystems.metadata}, '$.createdBy') = ${owner}`
      : undefined
    const [existing] = await storage.db
      .select()
      .from(sqliteSystems)
      .where(and(eq(sqliteSystems.name, name), ownerFilter))
      .limit(1)
    if (existing) return existing as StoredSystem
  } else {
    const ownerFilter = owner
      ? sql`${postgresSystems.metadata}->>'createdBy' = ${owner}`
      : undefined
    const [existing] = await storage.db
      .select()
      .from(postgresSystems)
      .where(and(eq(postgresSystems.name, name), ownerFilter))
      .limit(1)
    if (existing) return existing
  }
  return createSystem({ name, description: description ?? null })
}

export async function listSystemRuns(systemId: string, limit = 20): Promise<SystemRunSummary[]> {
  const storage = getStorage()
  if (storage.kind === 'sqlite') {
    return storage.db
      .select({
        id: sqliteThreatModels.id,
        title: sqliteThreatModels.title,
        status: sqliteThreatModels.status,
        versionHash: sqliteThreatModels.versionHash,
        totalThreats: sqliteThreatModels.totalThreats,
        createdAt: sqliteThreatModels.createdAt,
        completedAt: sqliteThreatModels.completedAt,
      })
      .from(sqliteThreatModels)
      .where(and(eq(sqliteThreatModels.systemId, systemId), eq(sqliteThreatModels.status, 'completed')))
      .orderBy(desc(sqliteThreatModels.completedAt))
      .limit(limit)
  }

  return storage.db
    .select({
      id: postgresThreatModels.id,
      title: postgresThreatModels.title,
      status: postgresThreatModels.status,
      versionHash: postgresThreatModels.versionHash,
      totalThreats: postgresThreatModels.totalThreats,
      createdAt: postgresThreatModels.createdAt,
      completedAt: postgresThreatModels.completedAt,
    })
    .from(postgresThreatModels)
    .where(and(eq(postgresThreatModels.systemId, systemId), eq(postgresThreatModels.status, 'completed')))
    .orderBy(desc(postgresThreatModels.completedAt))
    .limit(limit)
}
