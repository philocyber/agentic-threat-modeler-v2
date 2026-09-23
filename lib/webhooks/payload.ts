import type { UnifiedThreat } from '@/lib/models/types'

/**
 * Shape methodology-specific fields for webhook consumers (attack trees, PASTA).
 */
export function buildWebhookMethodologyData(threat: UnifiedThreat): {
  attackTree?: UnifiedThreat['attackTree']
  attackerProfile?: string
  attackVector?: string
  strideCategory?: string | null
  controlReference?: string | null
  owaspCategories?: string[] | null
} {
  return {
    ...(threat.attackTree !== undefined ? { attackTree: threat.attackTree } : {}),
    ...(threat.attackerProfile !== undefined ? { attackerProfile: threat.attackerProfile } : {}),
    ...(threat.attackVector !== undefined ? { attackVector: threat.attackVector } : {}),
    ...(threat.strideCategory !== undefined ? { strideCategory: threat.strideCategory } : {}),
    ...(threat.controlReference !== undefined ? { controlReference: threat.controlReference } : {}),
    ...(threat.owaspCategories !== undefined ? { owaspCategories: threat.owaspCategories } : {}),
  }
}

export function mapThreatsForWebhook(threats: UnifiedThreat[]): Array<
  UnifiedThreat & { methodology_data: ReturnType<typeof buildWebhookMethodologyData> }
> {
  return threats.map((threat) => ({
    ...threat,
    methodology_data: buildWebhookMethodologyData(threat),
  }))
}
