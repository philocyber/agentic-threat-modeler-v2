import { z } from 'zod'
import { workspaceRoute } from '@/lib/local-route'
import { getThreatModel, listThreats } from '@/lib/storage/threat-models'
import { mapRowToUnifiedThreat } from '@/lib/db/helpers'
import { diffThreatRuns } from '@/lib/threats/diff'
import { activeWorkspaceOrNull, readWorkspaceText } from '@/lib/workspace/artifacts'
import type { UnifiedThreat } from '@/lib/models/types'

const QuerySchema = z.object({
  compareWith: z.string().min(1),
})

async function loadThreatsForRun(runId: string): Promise<UnifiedThreat[]> {
  const workspace = activeWorkspaceOrNull()
  if (workspace) {
    try {
      const raw = await readWorkspaceText(workspace, `runs/${runId}/threats.json`)
      const parsed = JSON.parse(raw) as UnifiedThreat[]
      if (Array.isArray(parsed)) return parsed
    } catch {
      // fall through to DB
    }
  }
  const rows = await listThreats(runId)
  return rows.map(mapRowToUnifiedThreat)
}

export const GET = workspaceRoute(async (request, { params }) => {
  const { id } = params as { id: string }
  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({ compareWith: url.searchParams.get('compareWith') })
  if (!parsed.success) {
    return Response.json({ error: 'compareWith query param is required' }, { status: 400 })
  }

  const base = await getThreatModel(id)
  const compare = await getThreatModel(parsed.data.compareWith)
  if (!base || !compare) {
    return Response.json({ error: 'One or both runs not found' }, { status: 404 })
  }
  if (base.status !== 'completed' || compare.status !== 'completed') {
    return Response.json({ error: 'Both runs must be completed' }, { status: 400 })
  }
  if (base.systemId && compare.systemId && base.systemId !== compare.systemId) {
    return Response.json({ error: 'Runs belong to different systems' }, { status: 400 })
  }

  const [baseThreats, compareThreats] = await Promise.all([
    loadThreatsForRun(id),
    loadThreatsForRun(parsed.data.compareWith),
  ])

  const diff = diffThreatRuns(id, parsed.data.compareWith, baseThreats, compareThreats)
  return Response.json({
    data: {
      ...diff,
      base: { id: base.id, versionHash: base.versionHash, completedAt: base.completedAt },
      compare: { id: compare.id, versionHash: compare.versionHash, completedAt: compare.completedAt },
    },
  })
})
