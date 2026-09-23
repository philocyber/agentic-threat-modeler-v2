import { workspaceRoute } from '@/lib/local-route'
import { getThreatModel, requestThreatModelCancellation } from '@/lib/storage/threat-models'

export const POST = workspaceRoute(async (_req, { params }) => {
  const { id } = params as { id: string }

  const existing = await getThreatModel(id)
  if (!existing) {
    return Response.json({ error: 'Threat model not found' }, { status: 404 })
  }

  const cancelled = await requestThreatModelCancellation(id)
  if (!cancelled) {
    const fresh = await getThreatModel(id)
    if (fresh?.status === 'failed') {
      return Response.json({ ok: true, id, already_stopped: true })
    }

    return Response.json(
      {
        error:
          fresh?.status === 'completed'
            ? 'Threat model already completed before it could be stopped'
            : 'Threat model is not running',
      },
      { status: 409 },
    )
  }

  return Response.json({ ok: true, id, already_stopped: false })
})
