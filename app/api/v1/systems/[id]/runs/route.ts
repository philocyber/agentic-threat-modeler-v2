import { localRoute } from '@/lib/local-route'
import { getSystem, listSystemRuns } from '@/lib/storage/systems'

export const GET = localRoute(async (_request, params) => {
  const { id } = params as { id: string }
  const system = await getSystem(id)
  if (!system) return Response.json({ error: 'System not found' }, { status: 404 })

  const runs = await listSystemRuns(id, 50)
  return Response.json({ data: { system, runs } })
})
