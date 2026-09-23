import { randomUUID } from 'crypto'
import type { UnifiedThreat } from '@/lib/models/types'
import { calculateSeverity } from '@/lib/models/scoring'
import type { NewThreat } from './schema'

// Re-export so existing consumers of '@/lib/db/helpers' keep working;
// the single threshold table lives in lib/models/scoring.ts.
export { calculateSeverity }

/**
 * Generate a threat model ID
 */
export function generateThreatModelId(): string {
  return `tm_${randomUUID()}`
}

/**
 * Generate a unique threat ID
 */
export function generateThreatId(): string {
  return `THR-${randomUUID()}`
}

/**
 * Convert UnifiedThreat to database Threat row
 */
export function mapUnifiedThreatToRow(
  threat: UnifiedThreat,
  threatModelId: string
): NewThreat {
  // Use threat.title from DREAD validator enrichment, or fallback to component:description
  // Limit to 500 chars total (DB constraint) - being conservative: 490 chars max
  const MAX_TITLE_LENGTH = 490
  let title = threat.title 
    ? threat.title
    : threat.component 
      ? `${threat.component}: ${threat.description}` 
      : threat.description
  
  // Truncate if exceeds limit
  if (title.length > MAX_TITLE_LENGTH) {
    title = title.slice(0, MAX_TITLE_LENGTH) + '...'
  }

  return {
    id: generateThreatId(),
    threatModelId,
    title,
    description: threat.description,
    component: threat.component ?? null,
    strideCategory: threat.strideCategory ?? null,
    methodology: threat.methodology ?? null,
    dreadDamage: threat.scoringStatus === 'unscored' ? null : threat.dread.damage ?? null,
    dreadReproducibility: threat.scoringStatus === 'unscored' ? null : threat.dread.reproducibility ?? null,
    dreadExploitability: threat.scoringStatus === 'unscored' ? null : threat.dread.exploitability ?? null,
    dreadAffectedUsers: threat.scoringStatus === 'unscored' ? null : threat.dread.affectedUsers ?? null,
    dreadDiscoverability: threat.scoringStatus === 'unscored' ? null : threat.dread.discoverability ?? null,
    severity: threat.scoringStatus === 'unscored' ? null : calculateSeverity(threat.dread),
    impact: threat.impact ?? null,
    mitigation: threat.mitigation ?? null,
    controlReference: threat.controlReference ?? null,
    owaspCategories: threat.owaspCategories ?? null,
    confidenceScore: Math.round(threat.confidenceScore * 100),
    evidenceSources: threat.evidenceSources ?? null,
    reasoning: threat.reasoning ?? null,
    methodologyData: buildMethodologyData(threat),
    traceability: threat.traceability ?? null,
    userComments: threat.userComments ?? null,
    reviewStatus: threat.reviewStatus ?? null,
    reviewNotes: threat.reviewNotes ?? null,
    reviewedAt: threat.reviewedAt && typeof threat.reviewedAt === 'string' && threat.reviewedAt.trim() ? new Date(threat.reviewedAt) : null,
  }
}

function buildMethodologyData(threat: UnifiedThreat): NewThreat['methodologyData'] {
  if (!threat.attackTree && !threat.attackerProfile && !threat.attackVector &&
      !threat.methodologies?.length && !threat.sourceCandidateIds?.length &&
      !threat.scoringStatus && !threat.scoringRationale && !threat.disposition && !threat.preconditions?.length && !threat.residualRiskNotes) return null
  return {
    ...(threat.attackTree ? { attackTree: threat.attackTree } : {}),
    ...(threat.attackerProfile ? { attackerProfile: threat.attackerProfile } : {}),
    ...(threat.attackVector ? { attackVector: threat.attackVector } : {}),
    ...(threat.methodologies?.length ? { methodologies: threat.methodologies } : {}),
    ...(threat.sourceCandidateIds?.length ? { sourceCandidateIds: threat.sourceCandidateIds } : {}),
    ...(threat.scoringStatus ? { scoringStatus: threat.scoringStatus } : {}),
    ...(threat.scoringRationale ? { scoringRationale: threat.scoringRationale } : {}),
    ...(threat.disposition ? { disposition: threat.disposition } : {}),
    ...(threat.preconditions?.length ? { preconditions: threat.preconditions } : {}),
    ...(threat.residualRiskNotes ? { residualRiskNotes: threat.residualRiskNotes } : {}),
  }
}

/**
 * Convert database Threat row to UnifiedThreat
 */
export function mapRowToUnifiedThreat(row: {
  id: string
  title: string  // Always present in DB (NOT NULL constraint)
  component: string | null
  strideCategory: string | null
  methodology: string | null
  description: string
  impact: string | null
  mitigation: string | null
  controlReference: string | null
  owaspCategories: unknown
  dreadDamage: number | null
  dreadReproducibility: number | null
  dreadExploitability: number | null
  dreadAffectedUsers: number | null
  dreadDiscoverability: number | null
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null
  confidenceScore: number | null
  evidenceSources: unknown
  reasoning: string | null
  methodologyData?: unknown
  traceability: unknown
  userComments: string | null
  reviewStatus: string | null
  reviewNotes: string | null
  reviewedAt: Date | null
}): UnifiedThreat {
  const priority = mapSeverityToPriority(row.severity)
  const methodologyData = (row.methodologyData ?? null) as {
    attackTree?: UnifiedThreat['attackTree']
    attackerProfile?: string
    attackVector?: string
    methodologies?: UnifiedThreat['methodologies']
    sourceCandidateIds?: string[]
    scoringStatus?: UnifiedThreat['scoringStatus']
    scoringRationale?: string
    disposition?: UnifiedThreat['disposition']
    preconditions?: string[]
    residualRiskNotes?: string
  } | null
  const dread = {
    damage: row.dreadDamage ?? 0,
    reproducibility: row.dreadReproducibility ?? 0,
    exploitability: row.dreadExploitability ?? 0,
    affectedUsers: row.dreadAffectedUsers ?? 0,
    discoverability: row.dreadDiscoverability ?? 0,
    total:
      ((row.dreadDamage ?? 0) +
        (row.dreadReproducibility ?? 0) +
        (row.dreadExploitability ?? 0) +
        (row.dreadAffectedUsers ?? 0) +
        (row.dreadDiscoverability ?? 0)) /
      5,
  }

  return {
    id: row.id,
    title: row.title,  // Architectural threat pattern (always present due to NOT NULL constraint and fallback generation)
    component: row.component ?? 'Unknown',
    strideCategory: row.strideCategory ?? undefined,
    methodology: (row.methodology as UnifiedThreat['methodology']) ?? 'SYNTHESIS',
    description: row.description,
    impact: row.impact ?? '',
    mitigation: row.mitigation ?? '',
    controlReference: row.controlReference ?? undefined,
    owaspCategories: (row.owaspCategories as string[]) ?? [],
    dread,
    priority,
    confidenceScore: (row.confidenceScore ?? 50) / 100,
    evidenceSources: (row.evidenceSources as UnifiedThreat['evidenceSources']) ?? [],
    reasoning: row.reasoning ?? undefined,
    attackTree: methodologyData?.attackTree,
    attackerProfile: methodologyData?.attackerProfile,
    attackVector: methodologyData?.attackVector,
    methodologies: methodologyData?.methodologies,
    sourceCandidateIds: methodologyData?.sourceCandidateIds,
    scoringStatus: [row.dreadDamage, row.dreadReproducibility, row.dreadExploitability, row.dreadAffectedUsers, row.dreadDiscoverability].some(n => n == null) ? 'unscored' : methodologyData?.scoringStatus,
    scoringRationale: methodologyData?.scoringRationale,
    disposition: methodologyData?.disposition,
    preconditions: methodologyData?.preconditions,
    residualRiskNotes: methodologyData?.residualRiskNotes,
    traceability: (row.traceability as UnifiedThreat['traceability']) ?? undefined,
    userComments: row.userComments ?? undefined,
    reviewStatus: row.reviewStatus as UnifiedThreat['reviewStatus'],
    reviewNotes: row.reviewNotes ?? undefined,
    reviewedAt: row.reviewedAt?.toISOString(),
  }
}

function mapSeverityToPriority(
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null
): 'low' | 'medium' | 'high' | 'critical' {
  if (!severity) return 'medium'
  return severity.toLowerCase() as 'low' | 'medium' | 'high' | 'critical'
}
