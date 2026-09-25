import { workspaceRoute } from '@/lib/local-route'
import { listThreatModels, listThreats, type AnalysisStatus } from '@/lib/storage/threat-models'
import { mapRowToUnifiedThreat } from '@/lib/db/helpers'
import { reviewCounts } from '@/lib/ui/review-queue'

const ALLOWED_STATUSES = new Set<AnalysisStatus>(['pending', 'running', 'completed', 'partial', 'failed'])

export const GET = workspaceRoute(async (req, { workspace }) => {
  const { searchParams } = req.nextUrl
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1'))
  const limit = Math.min(50, parseInt(searchParams.get('limit') ?? '20'))
  const requestedStatus = searchParams.get('status')
  const archived = searchParams.get('archived') === 'true'
  const status = ALLOWED_STATUSES.has(requestedStatus as AnalysisStatus)
    ? (requestedStatus as AnalysisStatus)
    : null

  // Local workspace mode with several projects: the register stays empty until
  // the user picks one, same as the learning stats route.
  if (!workspace && !process.env.DATABASE_URL) {
    return Response.json({ data: [], page, limit, archived, projectActive: false })
  }

  const results = await listThreatModels({ page, limit, status, archived })
  if (searchParams.get('includeReview') === 'true') {
    const data = await Promise.all(results.map(async (result) => {
      const rows = await listThreats(result.id)
      return {
        ...result,
        reviewSummary: rows.length === 0 && (result.totalThreats ?? 0) > 0
          ? null
          : reviewCounts(rows.map(mapRowToUnifiedThreat)),
      }
    }))
    return Response.json({ data, page, limit, archived, projectActive: Boolean(workspace) })
  }

  return Response.json({ data: results, page, limit, archived, projectActive: Boolean(workspace) })
})
