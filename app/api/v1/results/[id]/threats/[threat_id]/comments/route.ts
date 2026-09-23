import { workspaceRoute } from '@/lib/local-route'
import type { ThreatCommentRequest } from '@/lib/models/types'
import { logger } from '@/lib/logger'
import { getThreat, getThreatModel, updateThreat } from '@/lib/storage/threat-models'
import { ThreatCommentRequestSchema } from '@/lib/api/schemas'

export const PATCH = workspaceRoute(async (req, { params }) => {
  if (!params?.id || !params?.threat_id) {
    return Response.json({ error: 'Missing required parameters' }, { status: 400 })
  }
  const threatModelId = params.id
  const threatId = params.threat_id

  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = ThreatCommentRequestSchema.safeParse(rawBody)
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? 'Invalid comment request' }, { status: 400 })
  }
  const body: ThreatCommentRequest = parsed.data

  if (typeof body.user_comments !== 'string') {
    return Response.json({ error: 'user_comments is required and must be a string' }, { status: 400 })
  }

  if (body.user_comments.length > 10000) {
    return Response.json({ error: 'user_comments exceeds maximum length of 10000 characters' }, { status: 400 })
  }

  const threatModel = await getThreatModel(threatModelId)
  if (!threatModel) {
    return Response.json({ error: 'Threat model not found' }, { status: 404 })
  }

  if (threatModel.status !== 'completed' && threatModel.status !== 'partial') {
    return Response.json(
      { error: 'Cannot edit threats while analysis is still running', status: threatModel.status },
      { status: 409 },
    )
  }

  const threat = await getThreat(threatModelId, threatId)
  if (!threat) {
    return Response.json({ error: 'Threat not found' }, { status: 404 })
  }

  await updateThreat(threatModelId, threatId, { userComments: body.user_comments })

  await logger.info(
    `Comment added to threat ${threatId}`,
    { threatModelId, threatId, commentLength: body.user_comments.length },
    {
      audit: {
        eventType: 'threat_comment_added',
        metadata: { threatModelId, threatId },
      },
    },
  )

  return Response.json({
    threat_id: threatId,
    user_comments: body.user_comments,
    updated_at: new Date().toISOString(),
  })
})
