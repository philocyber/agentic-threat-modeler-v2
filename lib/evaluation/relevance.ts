import type { EvidenceSource } from '@/lib/db/schema'
import type { CanonicalPassage } from '@/lib/architecture/passage-catalog'

export type RelevanceStatus = 'relevant' | 'not_relevant' | 'insufficient'

function tokens(text: string): Set<string> {
  return new Set((text.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}_/-]{3,}/gu) ?? [])
    .filter((token) => !['the', 'and', 'for', 'with', 'from', 'this', 'that', 'source', 'component'].includes(token)))
}

export function componentAnchored(haystack: string, component: string): boolean {
  const hay = haystack.normalize('NFC').toLowerCase()
  const full = component.normalize('NFC').trim().toLowerCase()
  if (full.length < 3) return false
  const containsPhrase = (needle: string) => {
    let offset = hay.indexOf(needle)
    while (offset !== -1) {
      const before = hay[offset - 1] ?? ''
      const after = hay[offset + needle.length] ?? ''
      if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return true
      offset = hay.indexOf(needle, offset + 1)
    }
    return false
  }
  if (containsPhrase(full)) return true

  // Models sometimes name an architecture path rather than one catalog label,
  // for example "Procurement Agent / Human Approver Queue". Source prose also
  // commonly drops a type suffix ("Supplier" under "External APIs"). Require
  // every path segment to resolve, while accepting that harmless presentation
  // difference.
  const segmentAnchored = (segment: string) => {
    const normalized = segment.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()
    const withoutType = normalized.replace(/\s+(?:agents?|apis?|queues?|services?|providers?|databases?|dbs?|stores?|infrastructure)$/u, '').trim()
    return containsPhrase(normalized) || (withoutType.length >= 3 && containsPhrase(withoutType))
  }
  const pathAnchored = (path: string) => {
    const segments = path
      // Local analysts naturally return comma-separated architecture paths.
      // Treat commas like the existing arrows and conjunctions, while still
      // requiring every endpoint to appear in the cited original passage.
      .split(/\s*(?:→|↔|\/|\+|&|;|,|\band\b)\s*/iu)
      .map((segment) => segment.replace(/\s+/g, ' ').trim())
      .filter((segment) => segment.length >= 3)
    return segments.length > 0 && segments.every(segmentAnchored)
  }

  const withoutParenthetical = full.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  const parentheticalGroups = [...full.matchAll(/\(([^)]+)\)/g)].map(match => match[1] ?? '')
  const parentheticalAnchored = parentheticalGroups.every(group => {
    const normalizedGroup = group.replace(/\s+/g, ' ').trim()
    // Transport and presentation notes refine a documented component; they do
    // not introduce another endpoint that needs a separate source anchor.
    if (/^(?:via|over|through|across|using|on)\b/iu.test(normalizedGroup)) return true
    if (/^(?:front-?end|back-?end|internal|external|local|remote|hosted model|read-only|third-party)$/iu.test(normalizedGroup)) return true
    const segments = group.split(/\s*(?:→|↔|\/|\+|&|;|,|\band\b)\s*/iu)
      .map(segment => segment.trim()).filter(segment => segment.length >= 3)
    return segments.length > 0 && segments.every(segmentAnchored)
  })
  if (pathAnchored(withoutParenthetical) && parentheticalAnchored) return true

  // Relationship labels often put their real endpoints in parentheses, for
  // example "Multi-Agent Communication (Orchestrator ↔ Sub-agents)".
  // Require at least two anchored endpoints so a decorative parenthetical
  // cannot make an otherwise unknown component appear valid.
  return [...full.matchAll(/\(([^)]+)\)/g)].some((match) => {
    const path = match[1] ?? ''
    const segments = path.split(/\s*(?:→|↔|\/|\+|&|;|,|\band\b)\s*/iu).filter(segment => segment.trim().length >= 3)
    return segments.length >= 2 && pathAnchored(path)
  })
}

/** Lexical overlap only. A verified citation is not proof the argument holds. */
export function assessPassageRelevance(params: {
  component: string
  scenario?: string
  description?: string
  passage: CanonicalPassage
}): RelevanceStatus {
  const hay = `${params.passage.section}\n${params.passage.text}`
  const component = params.component.trim()
  if (componentAnchored(hay, component)) {
    const claim = `${params.scenario ?? ''} ${params.description ?? ''}`
    if (!claim.trim()) return 'insufficient'
    const claimTokens = tokens(claim)
    const passageTokens = tokens(hay)
    if (claimTokens.size === 0) return 'insufficient'
    const overlap = [...claimTokens].filter((token) => passageTokens.has(token)).length
    return overlap >= 2 && overlap / claimTokens.size >= 0.12 ? 'relevant' : 'not_relevant'
  }
  if (params.passage.kind === 'rag') return 'not_relevant'
  return 'insufficient'
}

export function withRelevance(
  evidence: EvidenceSource,
  relevance: RelevanceStatus,
): EvidenceSource {
  return { ...evidence, relevanceStatus: relevance }
}
