import { z } from 'zod'
import { workspaceRoute } from '@/lib/local-route'
import { createSystem, listSystems } from '@/lib/storage/systems'

const CreateSystemSchema = z.object({
  name: z.string().trim().min(1).max(500),
  description: z.string().trim().max(5000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const GET = workspaceRoute(async (_request, { workspace }) => {
  if (!workspace && !process.env.DATABASE_URL) {
    return Response.json(
      { error: 'Select or create a local project before loading systems.', code: 'NO_ACTIVE_PROJECT' },
      { status: 409 },
    )
  }
  const systems = await listSystems(100)
  return Response.json({ data: systems })
})

export const POST = workspaceRoute(async (request, { workspace }) => {
  if (!workspace && !process.env.DATABASE_URL) {
    return Response.json(
      { error: 'Select or create a local project before creating a system.', code: 'NO_ACTIVE_PROJECT' },
      { status: 409 },
    )
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = CreateSystemSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'Invalid system payload' }, { status: 400 })
  }

  const system = await createSystem({
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    metadata: parsed.data.metadata ?? null,
  })
  return Response.json({ data: system }, { status: 201 })
})
