import { randomUUID } from 'node:crypto'
import { db as postgresDb } from '@/lib/db'
import { auditLogs as postgresAuditLogs } from '@/lib/db/schema'
import { auditLogs as sqliteAuditLogs } from '@/lib/db/schema.sqlite'
import { getStorage } from './context'

export type AuditLogInput = {
  eventType: string
  ipAddress?: string | null
  userAgent?: string | null
  metadata?: Record<string, unknown>
}

export async function insertAuditLog(input: AuditLogInput): Promise<void> {
  const storage = getStorage()
  if (storage.kind === 'sqlite') {
    await storage.db.insert(sqliteAuditLogs).values({
      id: randomUUID(),
      eventType: input.eventType,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      metadata: input.metadata ?? null,
    })
    return
  }

  await postgresDb.insert(postgresAuditLogs).values({
    eventType: input.eventType as never,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    metadata: input.metadata,
  })
}
