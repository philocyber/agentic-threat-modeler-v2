import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { localRoute } from '@/lib/local-route'
import { getSystem, updateSystem } from '@/lib/storage/systems'
import { getStorage } from '@/lib/storage/context'

const UpdateSystemSchema = z.object({
  name: z.string().trim().min(1).max(500).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
})

export const GET = localRoute(async (_request, params) => {
  const { id } = params as { id: string }
  const system = await getSystem(id)
  if (!system) return Response.json({ error: 'System not found' }, { status: 404 })
  return Response.json({ data: system })
})

export const PATCH = localRoute(async (request, params) => {
  const { id } = params as { id: string }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = UpdateSystemSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'Invalid system payload' }, { status: 400 })
  }

  const patch: { name?: string; description?: string | null; metadata?: Record<string, unknown> | null } = {}
  if (parsed.data.name !== undefined) patch.name = parsed.data.name
  if (parsed.data.description !== undefined) patch.description = parsed.data.description
  if (parsed.data.metadata !== undefined) patch.metadata = parsed.data.metadata

  const updated = await updateSystem(id, patch)
  if (!updated) return Response.json({ error: 'System not found' }, { status: 404 })
  return Response.json({ data: updated })
})

export const DELETE = localRoute(async (_request, params) => {
  const { id } = params as { id: string }
  const existing = await getSystem(id)
  if (!existing) return Response.json({ error: 'System not found' }, { status: 404 })
  const storage = getStorage()
  if (storage.kind === 'sqlite') {
    const { systems: sqliteSystems } = await import('@/lib/db/schema.sqlite')
    const deleted = await storage.db
      .delete(sqliteSystems)
      .where(eq(sqliteSystems.id, id))
      .returning({ id: sqliteSystems.id })
    if (deleted.length === 0) return Response.json({ error: 'System not found' }, { status: 404 })
    return Response.json({ ok: true })
  }

  const { systems: pgSystems } = await import('@/lib/db/schema')
  const deleted = await storage.db
    .delete(pgSystems)
    .where(eq(pgSystems.id, id))
    .returning({ id: pgSystems.id })
  if (deleted.length === 0) return Response.json({ error: 'System not found' }, { status: 404 })
  return Response.json({ ok: true })
})
