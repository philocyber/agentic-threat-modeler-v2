import { workspaceRoute } from '@/lib/local-route'
import { calculateSeverity, mapRowToUnifiedThreat } from '@/lib/db/helpers'
import { logger } from '@/lib/logger'
import { getThreat, getThreatModel, updateThreat } from '@/lib/storage/threat-models'
import { ThreatUpdateRequestSchema } from '@/lib/api/schemas'

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
  const parsed = ThreatUpdateRequestSchema.safeParse(rawBody)
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? 'Invalid review request' }, { status: 400 })
  }
  const body = parsed.data

  const dreadFields = [
    'dread_damage',
    'dread_reproducibility',
    'dread_exploitability',
    'dread_affected_users',
    'dread_discoverability',
  ] as const

  for (const field of dreadFields) {
    const value = body[field]
    if (value !== undefined && (value < 1 || value > 10 || !Number.isInteger(value))) {
      return Response.json({ error: `${field} must be an integer between 1 and 10` }, { status: 400 })
    }
  }

  if (body.review_status && !['pending', 'confirmed', 'rejected'].includes(body.review_status)) {
    return Response.json(
      { error: 'review_status must be one of: pending, confirmed, rejected' },
      { status: 400 },
    )
  }

  const validStrideCategories = [
    'S',
    'T',
    'R',
    'I',
    'D',
    'E',
    'Spoofing',
    'Tampering',
    'Repudiation',
    'Information Disclosure',
    'Denial of Service',
    'Elevation of Privilege',
  ]
  if (body.stride_category && !validStrideCategories.includes(body.stride_category)) {
    return Response.json({ error: 'stride_category must be a valid STRIDE category' }, { status: 400 })
  }

  if (body.description !== undefined && body.description.length > 5000) {
    return Response.json({ error: 'description exceeds maximum length of 5000 characters' }, { status: 400 })
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

  if (
    body.review_status &&
    body.review_status !== 'pending' &&
    !body.review_notes?.trim() &&
    !threat.reviewNotes?.trim() &&
    !threat.userComments?.trim()
  ) {
    return Response.json(
      { error: 'review_notes is required when confirming or rejecting a threat' },
      { status: 400 },
    )
  }

  if (body.review_notes !== undefined && body.review_notes.length > 4000) {
    return Response.json({ error: 'review_notes exceeds maximum length of 4000 characters' }, { status: 400 })
  }

  const updateData: Parameters<typeof updateThreat>[2] = {}
  if (body.description !== undefined) updateData.description = body.description
  if (body.stride_category !== undefined) updateData.strideCategory = body.stride_category

  let dreadUpdated = false
  if (body.dread_damage !== undefined) {
    updateData.dreadDamage = body.dread_damage
    dreadUpdated = true
  }
  if (body.dread_reproducibility !== undefined) {
    updateData.dreadReproducibility = body.dread_reproducibility
    dreadUpdated = true
  }
  if (body.dread_exploitability !== undefined) {
    updateData.dreadExploitability = body.dread_exploitability
    dreadUpdated = true
  }
  if (body.dread_affected_users !== undefined) {
    updateData.dreadAffectedUsers = body.dread_affected_users
    dreadUpdated = true
  }
  if (body.dread_discoverability !== undefined) {
    updateData.dreadDiscoverability = body.dread_discoverability
    dreadUpdated = true
  }

  if (dreadUpdated) {
    updateData.severity = calculateSeverity({
      damage: updateData.dreadDamage ?? threat.dreadDamage ?? 0,
      reproducibility: updateData.dreadReproducibility ?? threat.dreadReproducibility ?? 0,
      exploitability: updateData.dreadExploitability ?? threat.dreadExploitability ?? 0,
      affectedUsers: updateData.dreadAffectedUsers ?? threat.dreadAffectedUsers ?? 0,
      discoverability: updateData.dreadDiscoverability ?? threat.dreadDiscoverability ?? 0,
    })
  }

  let reviewFieldsModified = false
  if (body.review_status !== undefined) {
    updateData.reviewStatus = body.review_status
    reviewFieldsModified = true
  }
  if (body.review_notes !== undefined) {
    updateData.reviewNotes = body.review_notes.trim()
    reviewFieldsModified = true
  }
  if (reviewFieldsModified) updateData.reviewedAt = new Date()

  const updated = await updateThreat(threatModelId, threatId, updateData)
  if (!updated) {
    return Response.json({ error: 'Threat not found' }, { status: 404 })
  }

  const eventType = reviewFieldsModified ? 'threat_review_updated' : 'threat_justified'
  await logger.info(
    `Threat ${threatId} updated`,
    { threatModelId, threatId, changes: Object.keys(updateData) },
    {
      audit: {
        eventType,
        metadata: {
          threatModelId,
          threatId,
          changedFields: Object.keys(updateData),
          reviewStatus: updateData.reviewStatus,
          dreadUpdated,
        },
      },
    },
  )

  return Response.json(mapRowToUnifiedThreat(updated))
})
