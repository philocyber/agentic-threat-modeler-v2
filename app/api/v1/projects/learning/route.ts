import { workspaceRoute } from '@/lib/local-route'
import { getLearningStats } from '@/lib/storage/review-learning'

export const GET = workspaceRoute(async (request, { workspace }) => {
  const systemId = new URL(request.url).searchParams.get('systemId')?.trim() || undefined
  if (!workspace && !process.env.DATABASE_URL) {
    return Response.json({
      data: {
        confirmed: 0,
        rejected: 0,
        pending: 0,
        reviewed: 0,
        precision: null,
        examplesForNextRun: 0,
        projectActive: false,
      },
    })
  }

  const stats = await getLearningStats(systemId)
  return Response.json({
    data: { ...stats, learningSystemId: systemId ?? null, projectActive: Boolean(workspace), projectName: workspace?.name ?? null },
  })
})
