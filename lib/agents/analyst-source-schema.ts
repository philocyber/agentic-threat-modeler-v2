import { z } from 'zod'
import type { ArchitectureData } from '@/lib/models/types'
import type { EvidenceSource } from '@/lib/db/schema'
import { verifyEvidenceSource } from '@/lib/evaluation/citation-integrity'
import { componentAnchored } from '@/lib/evaluation/relevance'

type AnalystOutput = {
  threats: Array<{ component: string; description: string; evidenceSources: EvidenceSource[] }>
}

/** Validate provenance while structured retries can still correct the answer. */
export function withAnalystSourceValidation<T extends AnalystOutput>(
  schema: z.ZodType<T>,
  architecture: ArchitectureData,
): z.ZodType<T> {
  const source = architecture.sourceEvidence
  if (!source) return schema
  const names = [...architecture.components ?? [], ...architecture.externalEntities ?? [], ...architecture.dataStores ?? []]
    .map(item => (typeof item === 'string' ? item : item.name).normalize('NFC').trim().toLowerCase()).filter(name => name.length >= 3)
  const containsName = (text: string, name: string) => {
    let offset = text.indexOf(name)
    while (offset !== -1) {
      const before = text[offset - 1] ?? ''
      const after = text[offset + name.length] ?? ''
      if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return true
      offset = text.indexOf(name, offset + 1)
    }
    return false
  }
  const componentTerms = (component: string) => component.normalize('NFC').toLowerCase()
    .match(/[\p{L}\p{N}_-]{4,}/gu)?.filter(term => ![
      'agent', 'agents', 'multi-agent', 'communication', 'interface', 'layer', 'service',
    ].includes(term)) ?? []
  const componentSegments = (component: string) => component.normalize('NFC').toLowerCase()
    .split(/\s*(?:→|↔|\/|\+|&|;|,|\band\b)\s*/iu)
    .map(segment => segment.trim()).filter(segment => segment.length >= 3)
  const canonicalEvidenceType = (evidence: EvidenceSource): EvidenceSource => {
    const reference = evidence.passageId ?? evidence.citationId ?? evidence.sourceName
    // Coordination decision: the canonical identifier namespace outranks a
    // model-emitted enum. Local models occasionally label a real RAG-* passage
    // as architecture; treating it as RAG preserves the citation and prevents
    // background material from satisfying the original-source requirement.
    if (/\bRAG-[a-f0-9]{24}\b/i.test(reference)) return { ...evidence, sourceType: 'rag' }
    if (/\bSRC-\d+\b/i.test(reference)) return { ...evidence, sourceType: 'architecture' }
    return evidence
  }
  const withCatalogAnchors = schema.transform((output, context) => {
    const threats = output.threats.map((threat) => {
      const normalizedThreat = {
        ...threat,
        evidenceSources: threat.evidenceSources.map(canonicalEvidenceType).map((evidence) => {
          if (evidence.sourceType !== 'architecture') return evidence
          const boundaryId = /\bB\d+\b/i.exec(evidence.sourceName)?.[0]?.toUpperCase()
          if (!boundaryId) return evidence
          const boundaryPattern = new RegExp(`(?:^|\\n)\\s*${boundaryId}\\s*[\\t ]`, 'i')
          const section = source.sections.find(candidate => boundaryPattern.test(candidate.text))
          if (!section) return evidence
          const line = section.text.split('\n').find(candidate => new RegExp(`^\\s*${boundaryId}\\s*[\\t ]`, 'i').test(candidate))
          return { ...evidence, sourceName: section.id, excerpt: line ?? section.text }
        }),
      }
      const verifiedCitations = normalizedThreat.evidenceSources
        .filter(evidence => evidence.sourceType === 'architecture')
        .map(evidence => verifyEvidenceSource(evidence, normalizedThreat, { source }))
        .filter(evidence => evidence.referenceStatus === 'verified')
      const citedText = verifiedCitations.map(evidence => `${evidence.sourceName}\n${evidence.excerpt}`).join('\n')
      if (componentAnchored(citedText, normalizedThreat.component)) return normalizedThreat

      // Smaller local models often cite the correct generic trust-boundary
      // section but omit the catalog section that names the concrete endpoint.
      // Add only an authoritative original section whose text anchors the
      // component. This repairs provenance without manufacturing a quotation.
      const component = normalizedThreat.component.normalize('NFC').trim().toLowerCase()
      const namedComponents = [...new Set(names.filter(name => containsName(component, name)))]
      const directAnchors = source.sections
        .filter(section => componentAnchored(section.text, normalizedThreat.component)).slice(0, 1)
      const citedEndpoint = componentSegments(normalizedThreat.component)
        .some(segment => componentAnchored(citedText, segment))
      const repairable = verifiedCitations.length > 0 && (namedComponents.length > 0
        || componentTerms(normalizedThreat.component)
          .some(term => containsName(citedText.normalize('NFC').toLowerCase(), term))
        || (directAnchors.length > 0 && citedEndpoint))
      if (!repairable) return normalizedThreat
      const anchors = namedComponents.length > 0
        ? namedComponents.filter(name => !containsName(citedText.normalize('NFC').toLowerCase(), name))
          .flatMap(name => source.sections.filter(section => containsName(section.text.normalize('NFC').toLowerCase(), name)).slice(0, 1))
        : directAnchors
      const existingIds = new Set(normalizedThreat.evidenceSources.filter(evidence => evidence.sourceType === 'architecture')
        .flatMap(evidence => evidence.passageId ?? evidence.sourceName.match(/SRC-\d+/)?.[0] ?? []))
      const additions = [...new Map(anchors.map(anchor => [anchor.id, anchor])).values()]
        .filter(anchor => !existingIds.has(anchor.id))
        .map(anchor => ({
          sourceType: 'architecture' as const,
          sourceName: anchor.id,
          excerpt: anchor.text.split('\n').find(line => componentAnchored(line, normalizedThreat.component)) ?? anchor.text,
        }))
      if (additions.length === 0) return normalizedThreat
      return {
        ...normalizedThreat,
        evidenceSources: [...normalizedThreat.evidenceSources, ...additions],
      }
    }).filter((threat) => {
      const citations = threat.evidenceSources
        .filter(evidence => evidence.sourceType === 'architecture')
        .map(evidence => verifyEvidenceSource(evidence, threat, { source }))
      if (citations.length === 0) return false
      // Coordination decision: preserve hard failure for unresolved IDs, but
      // discard only the individual candidate when every ID resolves and its
      // component still is not present. This keeps the valid part of a local
      // model batch instead of paying for a full regeneration that may be empty.
      if (citations.some(evidence => evidence.referenceStatus !== 'verified')) return true
      const citedText = citations.map(evidence => `${evidence.sourceName}\n${evidence.excerpt}`).join('\n')
      return componentAnchored(citedText, threat.component)
    })
    if (output.threats.length > 0 && threats.length === 0) {
      context.addIssue({
        code: 'custom', path: ['threats'],
        message: 'All generated candidates were rejected because no verified original architecture passage anchors their components. Correct the SRC references and component names, or explicitly explain why the supplied architecture supports no threats. Do not silently replace rejected candidates with an empty result.',
      })
      return z.NEVER
    }
    return { ...output, threats }
  }) as z.ZodType<T>

  return withCatalogAnchors.superRefine((output, context) => {
    const seen = new Map<string, number>()
    for (const [index, threat] of output.threats.entries()) {
      const citations = threat.evidenceSources
        .filter(evidence => evidence.sourceType === 'architecture')
        .map(evidence => verifyEvidenceSource(evidence, threat, { source }))
      const missing = citations.filter(evidence => evidence.referenceStatus !== 'verified')
      // Provenance is a hard contract; lexical claim overlap is a quality signal.
      // A low overlap score must not be reported as a nonexistent citation.
      const component = threat.component.normalize('NFC').trim().toLowerCase()
      const citedText = citations.filter(evidence => evidence.referenceStatus === 'verified')
        .map(evidence => `${evidence.sourceName}\n${evidence.excerpt}`.normalize('NFC').toLowerCase()).join('\n')
      // Every endpoint in a compound display label must occur in the cited
      // original text. This rejects labels that append an invented service to
      // one real component while still accepting documented paths.
      const anchored = component.length >= 3 && componentAnchored(citedText, threat.component)
      if (!anchored || missing.length) {
        const reason = missing.length
          ? `Unresolved original-source references: ${missing.map(evidence => evidence.passageId ?? evidence.sourceName).join(', ')}.`
          : citations.length === 0
            ? 'No original architecture reference was supplied.'
            : `The cited original passages do not name component "${threat.component}".`
        context.addIssue({
          code: 'custom', path: ['threats', index, 'evidenceSources'],
          message: `${reason} Cite a catalog passage identifier (SRC-…) from the supplied architecture that names this component. RAG background cannot replace architecture evidence. Remove a candidate when no original passage anchors it.`,
        })
      }
      const key = `${threat.component} ${threat.description}`.normalize('NFKC').toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
      const prior = seen.get(key)
      if (prior !== undefined) {
        context.addIssue({ code: 'custom', path: ['threats', index, 'description'],
          message: `This repeats threats[${prior}]. Keep one distinct candidate and preserve its supporting evidence.` })
      } else seen.set(key, index)
    }
  })
}
