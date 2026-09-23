import type { RawThreat, ArchitectureData } from '@/lib/models/types'
import { isInScope } from '@/lib/architecture/scope'

/** Calibrate existence-confidence from cited system evidence, independently of potential impact. */
export function calibrateCandidate(threat: RawThreat): RawThreat {
  const evidence = threat.evidenceSources.filter(s => s.sourceType === 'architecture')
  const uncertain = /\b(?:unverified|unconfirmed|unspecified|unknown|not (?:verified|confirmed|inspected)|requires? verification|require verification)\b/i
  const hasUnresolvedPrecondition = (evidence.some(s => uncertain.test(s.excerpt)) || /cannot establish|no (?:architecture |system )?(?:evidence|confirmation)|mechanism (?:unspecified|unconfirmed)/i.test(threat.reasoning ?? '')) &&
    uncertain.test(`${threat.reasoning ?? ''} ${threat.description} ${threat.attackTree?.tree.notes ?? ''}`)
  if (!hasUnresolvedPrecondition) return threat
  return {
    ...threat,
    confidenceScore: Math.min(threat.confidenceScore, 0.69),
    disposition: 'control_verification_needed',
    preconditions: [...new Set([...(threat.preconditions ?? []), ...evidence.filter(s => uncertain.test(s.excerpt)).map(s => `${s.sourceName}: ${s.excerpt}`)])],
  }
}

export function inScopeCandidates(threats: RawThreat[], architecture: ArchitectureData | null): RawThreat[] {
  const excluded = new Set(architecture?.components.filter(c => !isInScope(c)).map(c => c.name.toLowerCase()) ?? [])
  return threats.filter(t => !excluded.has(t.component.toLowerCase())).map(calibrateCandidate)
}
