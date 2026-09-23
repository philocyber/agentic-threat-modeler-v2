import { randomUUID } from 'node:crypto'
import { and, eq, gt, inArray, lt } from 'drizzle-orm'
import { uploads as postgresUploads } from '@/lib/db/schema'
import { uploads as sqliteUploads } from '@/lib/db/schema.sqlite'
import { getActiveWorkspace } from '@/lib/workspace/context'
import {
  readWorkspaceText,
  removeWorkspaceUploadArtifacts,
  sha256Hex,
  writeArtifactAtomic,
} from '@/lib/workspace/artifacts'
import { actorRequiresOwnership, getActor } from '@/lib/security/actor'
import { getStorage } from './context'

type PostgresUpload = typeof postgresUploads.$inferSelect
type PostgresNewUpload = typeof postgresUploads.$inferInsert

export type StoredUpload = PostgresUpload

export async function createUpload(values: PostgresNewUpload): Promise<void> {
  const actor = getActor()
  const sha256 = sha256Hex(values.content)
  const storage = await getStorage()
  if (storage.kind === 'sqlite') {
    const workspace = getActiveWorkspace()
    if (!workspace) throw new Error('Workspace context required for local uploads')

    const id = values.id ?? randomUUID()
    const dir = `inputs/${id}`

    await writeArtifactAtomic(workspace, `${dir}/extracted.txt`, values.content)
    await writeArtifactAtomic(
      workspace,
      `${dir}/manifest.json`,
      JSON.stringify(
        {
          id,
          originalName: values.originalName,
          mediaType: values.mediaType,
          size: values.size,
          sha256,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    )

    await storage.db.insert(sqliteUploads).values({
      id,
      originalName: values.originalName,
      mediaType: values.mediaType,
      content: '',
      size: values.size,
      relativePath: dir,
      sha256,
      expiresAt: values.expiresAt,
    })
    return
  }
  await storage.db.insert(postgresUploads).values({
    ...values,
    sha256,
    ownerPrincipalId: actor?.id ?? null,
    ownerPrincipalKind: actor?.kind ?? null,
  })
}

export async function getUploadsByIds(ids: string[]): Promise<StoredUpload[]> {
  if (ids.length === 0) return []
  const storage = await getStorage()
  if (storage.kind === 'sqlite') {
    const rows = await storage.db.select().from(sqliteUploads).where(and(
      inArray(sqliteUploads.id, ids),
      gt(sqliteUploads.expiresAt, new Date()),
    ))
    const workspace = getActiveWorkspace()
    return Promise.all(
      rows.map(async (row) => {
        let content = row.content
        if (!content && row.relativePath && workspace) {
          content = await readWorkspaceText(workspace, `${row.relativePath}/extracted.txt`)
        }
        if (row.sha256 && sha256Hex(content) !== row.sha256) {
          throw new Error(`Upload ${row.id} failed integrity verification`)
        }
        return {
          id: row.id,
          originalName: row.originalName,
          mediaType: row.mediaType,
          content,
          size: row.size,
          sha256: row.sha256,
          ownerPrincipalId: null,
          ownerPrincipalKind: null,
          expiresAt: row.expiresAt,
          createdAt: row.createdAt,
        }
      }),
    )
  }
  const actor = getActor()
  const ownership = actorRequiresOwnership(actor)
    ? and(
      eq(postgresUploads.ownerPrincipalKind, actor!.kind),
      eq(postgresUploads.ownerPrincipalId, actor!.id),
    )
    : undefined
  const rows = await storage.db.select().from(postgresUploads).where(and(
    inArray(postgresUploads.id, ids),
    gt(postgresUploads.expiresAt, new Date()),
    ownership,
  ))
  for (const row of rows) {
    if (!row.sha256 || sha256Hex(row.content) !== row.sha256) {
      throw new Error(`Upload ${row.id} failed integrity verification`)
    }
  }
  return rows
}

/** Opportunistic, bounded cleanup. Legacy unowned service uploads are eligible. */
export async function sweepExpiredUploads(limit = 25): Promise<number> {
  const storage = await getStorage()
  const now = new Date()
  if (storage.kind === 'sqlite') {
    const rows = await storage.db.select().from(sqliteUploads)
      .where(lt(sqliteUploads.expiresAt, now)).limit(limit)
    const workspace = getActiveWorkspace()
    for (const row of rows) {
      await storage.db.delete(sqliteUploads).where(eq(sqliteUploads.id, row.id))
      if (workspace && row.relativePath) {
        await removeWorkspaceUploadArtifacts(workspace, row.relativePath)
      }
    }
    return rows.length
  }
  const rows = await storage.db.select({ id: postgresUploads.id }).from(postgresUploads)
    .where(lt(postgresUploads.expiresAt, now)).limit(limit)
  if (rows.length > 0) {
    await storage.db.delete(postgresUploads).where(inArray(postgresUploads.id, rows.map((row) => row.id)))
  }
  return rows.length
}
