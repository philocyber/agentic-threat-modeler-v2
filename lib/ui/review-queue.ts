import type { UnifiedThreat } from '@/lib/models/types'

export type EvidenceState = 'source checked' | 'check quotation' | 'no original source'
export type ReviewQueueCategory = 'actionable' | 'verify' | 'pending' | 'reviewed'

function hasSupportingSource(threat: UnifiedThreat): boolean {
  return threat.evidenceSources?.some((source) => source.sourceType === 'architecture'
    && source.referenceStatus === 'verified' && source.supportStatus === 'supports') ?? false
}

export function evidenceState(threat: UnifiedThreat): EvidenceState {
  const architecture = threat.evidenceSources?.filter((source) => source.sourceType === 'architecture' && source.supportStatus !== 'unlinked') ?? []
  if (architecture.some((source) => source.referenceStatus === 'verified')) return 'source checked'
  return architecture.length ? 'check quotation' : 'no original source'
}

export function reviewQueueCategory(threat: UnifiedThreat): ReviewQueueCategory {
  if (threat.reviewStatus === 'confirmed' || threat.reviewStatus === 'rejected') return 'reviewed'
  if ((threat.priority === 'critical' || threat.priority === 'high')
    && threat.scoringStatus === 'validated'
    && (threat.disposition ?? 'applicable') === 'applicable'
    && hasSupportingSource(threat)) return 'actionable'
  if (threat.disposition === 'conditional' || threat.disposition === 'control_verification_needed'
    || !hasSupportingSource(threat) || threat.scoringStatus !== 'validated') return 'verify'
  return 'pending'
}

export function nextReviewAction(threat: UnifiedThreat): string {
  const category = reviewQueueCategory(threat)
  if (category === 'reviewed') return 'Decision recorded'
  if (evidenceState(threat) === 'no original source') return 'Locate source evidence'
  if (evidenceState(threat) === 'check quotation') return 'Verify source quotation'
  if (!hasSupportingSource(threat)) return 'Check source support'
  if (threat.disposition === 'conditional') return 'Check preconditions'
  if (threat.disposition === 'control_verification_needed') return 'Check control operation'
  if (threat.scoringStatus !== 'validated') return 'Check scenario and score'
  return 'Review and decide'
}

const CATEGORY_ORDER: Record<ReviewQueueCategory, number> = { actionable: 0, verify: 1, pending: 2, reviewed: 3 }
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 }

export function sortReviewQueue(threats: UnifiedThreat[]): UnifiedThreat[] {
  return [...threats].sort((a, b) => CATEGORY_ORDER[reviewQueueCategory(a)] - CATEGORY_ORDER[reviewQueueCategory(b)]
    || SEVERITY_ORDER[a.priority] - SEVERITY_ORDER[b.priority]
    || a.title?.localeCompare(b.title ?? '') || a.id.localeCompare(b.id))
}

export function reviewCounts(threats: UnifiedThreat[]) {
  const counts = { pending: 0, actionable: 0, verify: 0, reviewed: 0 }
  for (const threat of threats) {
    const category = reviewQueueCategory(threat)
    if (category === 'reviewed') counts.reviewed += 1
    else {
      counts.pending += 1
      if (category === 'actionable') counts.actionable += 1
      if (category === 'verify') counts.verify += 1
    }
  }
  return counts
}
