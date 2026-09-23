import type { UnifiedThreat } from '@/lib/models/types'
import { normalizeThreatScore } from '@/lib/models/scoring'
import { withThreatDisplayIds } from '@/lib/models/threat-display-id'

export type ResultThreatSource = 'database' | 'artifact' | 'none'

export function resolveResultThreats(
  databaseThreats: UnifiedThreat[],
  artifactThreats: UnifiedThreat[] | null | undefined,
): { threats: UnifiedThreat[]; source: ResultThreatSource } {
  if (databaseThreats.length > 0) {
    return { threats: withThreatDisplayIds(databaseThreats.map(normalizeThreatScore)), source: 'database' }
  }
  if (artifactThreats && artifactThreats.length > 0) {
    return { threats: withThreatDisplayIds(artifactThreats.map(normalizeThreatScore)), source: 'artifact' }
  }
  return { threats: [], source: 'none' }
}
