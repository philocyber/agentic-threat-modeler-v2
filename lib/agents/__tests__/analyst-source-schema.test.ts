import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ArchitectureData } from '@/lib/models/types'
import { createSourceEvidence } from '@/lib/architecture/source-evidence'
import { withAnalystSourceValidation } from '../analyst-source-schema'
import { invokeStructuredWithRetry } from '../base'
import { applyCitationIntegrity } from '@/lib/evaluation/citation-integrity'

const quote = 'ReviewDesk requires human approval before publication; reviewer accuracy is not documented.'
const architecture = {
  sourceEvidence: createSourceEvidence(`# ReviewDesk\n${quote}\n\n# Archive\nThe Archive is read-only.`),
} as ArchitectureData
const schema = z.object({ threats: z.array(z.object({
  component: z.string(), description: z.string(), confidenceScore: z.number(),
  evidenceSources: z.array(z.object({ sourceType: z.enum(['architecture', 'rag']), sourceName: z.string(), excerpt: z.string() })),
})) })
const candidate = {
  component: 'ReviewDesk', description: 'An inaccurate draft may survive human review if reviewer checks are insufficient.', confidenceScore: 0.65,
  evidenceSources: [{ sourceType: 'architecture' as const, sourceName: 'SRC-0001', excerpt: quote }],
}
const checked = withAnalystSourceValidation(schema, architecture)

describe('analyst source validation before accepting emission', () => {
  it('accepts exact original evidence while preserving unknown controls and confidence', () => {
    expect(checked.parse({ threats: [candidate] }).threats[0]).toEqual(candidate)
  })

  it('keeps provenance valid when lexical relevance is uncertain, without promoting support', () => {
    const uncertain = { ...candidate, confidenceScore: 0.95,
      description: 'Unusual authorization semantics, ambiguous accountability, delegation credentials and asynchronous revocation require investigation.' }
    expect(checked.safeParse({ threats: [uncertain] }).success).toBe(true)
    const verified = applyCitationIntegrity(uncertain, { source: architecture.sourceEvidence })
    expect(verified.evidenceSources[0]?.referenceStatus).toBe('verified')
    expect(verified.evidenceSources[0]?.supportStatus).toBe('unlinked')
    expect(verified.confidenceScore).toBeLessThanOrEqual(0.69)
  })

  it('rejects an unresolved original-source ID', () => {
    const result = checked.safeParse({ threats: [{ ...candidate, evidenceSources: [
      { sourceType: 'architecture', sourceName: 'SRC-9999', excerpt: quote },
    ] }] })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['threats', 0, 'evidenceSources'])
  })

  it('drops only a candidate whose resolved passage does not anchor its component', () => {
    const mismatch = { ...candidate, evidenceSources: [
      { sourceType: 'architecture' as const, sourceName: 'SRC-0002', excerpt: quote },
    ] }
    expect(checked.parse({ threats: [candidate, mismatch] }).threats).toEqual([candidate])
  })

  it('does not silently accept zero after dropping every candidate without original architecture evidence', () => {
    const ragOnly = { ...candidate, evidenceSources: [
      { sourceType: 'rag' as const, sourceName: 'General security reference', excerpt: 'Human review may miss inaccurate content.' },
    ] }
    expect(checked.safeParse({ threats: [ragOnly] }).success).toBe(false)
  })

  it('accepts an explicitly empty analyst result without inventing a threat', () => {
    expect(checked.parse({ threats: [] })).toEqual({ threats: [] })
  })

  it('uses canonical citation IDs to correct a model-mislabeled RAG reference', () => {
    const mislabeledRag = {
      sourceType: 'architecture' as const,
      sourceName: 'RAG-bf9c317c995de1c4354b91b5',
      excerpt: 'Human review may miss inaccurate content.',
    }
    const parsed = checked.parse({ threats: [{
      ...candidate,
      evidenceSources: [...candidate.evidenceSources, mislabeledRag],
    }] })
    expect(parsed.threats[0]?.evidenceSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: 'rag', sourceName: mislabeledRag.sourceName }),
    ]))
  })

  it('does not let a model-mislabeled RAG reference replace architecture evidence', () => {
    const ragOnly = { ...candidate, evidenceSources: [{
      sourceType: 'architecture' as const,
      sourceName: 'RAG-bf9c317c995de1c4354b91b5',
      excerpt: 'Human review may miss inaccurate content.',
    }] }
    expect(checked.safeParse({ threats: [ragOnly] }).success).toBe(false)
  })

  it('rejects a fabricated extra quotation even beside a valid quotation', () => {
    expect(checked.safeParse({ threats: [{ ...candidate, evidenceSources: [...candidate.evidenceSources,
      { sourceType: 'architecture', sourceName: 'SRC-9999', excerpt: 'All employees have unrestricted publication permissions.' },
    ] }] }).success).toBe(false)
  })

  it('rejects repeated candidates but permits distinct questions on the same component', () => {
    const repeated = checked.safeParse({ threats: [candidate, { ...candidate, description: candidate.description.toUpperCase() }] })
    expect(repeated.success).toBe(false)
    if (!repeated.success) expect(repeated.error.issues[0]?.path).toEqual(['threats', 1, 'description'])
    expect(checked.safeParse({ threats: [candidate, { ...candidate, description: 'Confirm that the approval record remains attributable to the reviewer.' }] }).success).toBe(true)
  })

  it('repairs compound labels with authoritative catalog anchors', () => {
    const compositeArchitecture = { ...architecture, components: [{ name: 'ReviewDesk' }, { name: 'Archive' }] } as ArchitectureData
    const compositeSchema = withAnalystSourceValidation(schema, compositeArchitecture)
    const composite = { ...candidate, component: 'ReviewDesk → Archive', evidenceSources: [
      ...candidate.evidenceSources, { sourceType: 'architecture' as const, sourceName: 'SRC-0002', excerpt: 'The Archive is read-only.' },
    ] }
    expect(compositeSchema.safeParse({ threats: [composite] }).success).toBe(true)
    const repaired = compositeSchema.parse({ threats: [{ ...composite, evidenceSources: candidate.evidenceSources }] })
    expect(repaired.threats[0]?.evidenceSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: 'architecture', sourceName: 'SRC-0002' }),
    ]))
    expect(compositeSchema.safeParse({ threats: [{ ...candidate, component: 'FakeReviewDesk' }] }).success).toBe(false)
  })

  it('anchors comma-separated component paths without accepting an invented endpoint', () => {
    const compositeArchitecture = { ...architecture,
      components: [{ name: 'ReviewDesk' }, { name: 'Archive' }, { name: 'Policy Engine' }],
      sourceEvidence: createSourceEvidence(`# ReviewDesk\n${quote}\n\n# Archive and policy\nThe Archive is read-only and the Policy Engine evaluates access.`),
    } as ArchitectureData
    const compositeSchema = withAnalystSourceValidation(schema, compositeArchitecture)
    const cited = [{ sourceType: 'architecture' as const, sourceName: 'SRC-0001', excerpt: quote },
      { sourceType: 'architecture' as const, sourceName: 'SRC-0002', excerpt: 'The Archive is read-only and the Policy Engine evaluates access.' }]

    expect(compositeSchema.safeParse({ threats: [{ ...candidate,
      component: 'ReviewDesk, Archive, Policy Engine', evidenceSources: cited }] }).success).toBe(true)
    expect(compositeSchema.safeParse({ threats: [{ ...candidate,
      component: 'ReviewDesk, Invented MCP Server', evidenceSources: cited }] }).success).toBe(false)
  })

  it('repairs an exact catalog component cited only through a generic boundary', () => {
    const logisticsArchitecture = {
      components: [{ name: 'Logistics Agent' }],
      sourceEvidence: createSourceEvidence('# Boundaries\nAgents call external APIs across an untrusted boundary.\n\n# Actors\nLogistics Agent schedules ingredient deliveries.'),
    } as ArchitectureData
    const logistics = {
      ...candidate,
      component: 'Logistics Agent',
      evidenceSources: [{ sourceType: 'architecture' as const, sourceName: 'SRC-0001', excerpt: 'Agents call external APIs across an untrusted boundary.' }],
    }
    const repaired = withAnalystSourceValidation(schema, logisticsArchitecture).parse({ threats: [logistics] })
    expect(repaired.threats[0]?.evidenceSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceName: 'SRC-0002', excerpt: 'Logistics Agent schedules ingredient deliveries.' }),
    ]))
  })

  it('repairs a documented collective path even when the catalog has no matching component entry', () => {
    const collectiveArchitecture = {
      sourceEvidence: createSourceEvidence('# Boundaries\nAgents ↔ LLM Provider is an untrusted boundary.\n\n# Overview\nAll agents call a shared LLM Provider.'),
    } as ArchitectureData
    const collective = {
      ...candidate,
      component: 'All Agents / LLM Provider',
      evidenceSources: [{ sourceType: 'architecture' as const, sourceName: 'SRC-0001', excerpt: 'Agents ↔ LLM Provider is an untrusted boundary.' }],
    }
    const repaired = withAnalystSourceValidation(schema, collectiveArchitecture).parse({ threats: [collective] })
    expect(repaired.threats[0]?.evidenceSources).toEqual(expect.arrayContaining([expect.objectContaining({
      sourceName: 'SRC-0002',
      excerpt: expect.stringContaining('All agents call a shared LLM Provider'),
    })]))
  })

  it('anchors relationship labels whose concrete endpoints are parenthetical', () => {
    const relationship = {
      ...candidate,
      component: 'Review workflow (ReviewDesk ↔ Archive)',
      evidenceSources: [{ sourceType: 'architecture' as const, sourceName: 'SRC-0001', excerpt: quote }],
    }
    const result = withAnalystSourceValidation(schema, {
      ...architecture,
      sourceEvidence: createSourceEvidence(`# Review workflow\nReviewDesk ↔ Archive controls publication.`),
    } as ArchitectureData).safeParse({ threats: [relationship] })
    expect(result.success).toBe(true)
  })

  it('treats presentation and transport parentheticals as qualifiers, not endpoints', () => {
    const qualifierArchitecture = {
      sourceEvidence: createSourceEvidence('# Flow\nChat UI → Orchestrator Agent crosses the internal network.'),
    } as ArchitectureData
    const qualifierSchema = withAnalystSourceValidation(schema, qualifierArchitecture)
    const architectureEvidence = [{
      sourceType: 'architecture' as const,
      sourceName: 'SRC-0001',
      excerpt: 'Chat UI → Orchestrator Agent crosses the internal network.',
    }]
    expect(qualifierSchema.safeParse({ threats: [{ ...candidate,
      component: 'Chat UI (Frontend)', evidenceSources: architectureEvidence }] }).success).toBe(true)
    expect(qualifierSchema.safeParse({ threats: [{ ...candidate,
      component: 'Chat UI → Orchestrator Agent (via Internal Network)', evidenceSources: architectureEvidence }] }).success).toBe(true)
  })

  it('resolves a documented trust-boundary ID to its authoritative SRC section', () => {
    const boundaryArchitecture = {
      sourceEvidence: createSourceEvidence('# Boundaries\nB2\tReviewDesk ↔ Archive\tReview integrity'),
    } as ArchitectureData
    const boundaryCandidate = {
      ...candidate,
      evidenceSources: [{ sourceType: 'architecture' as const, sourceName: 'B2', excerpt: 'ReviewDesk ↔ Archive' }],
    }
    const repaired = withAnalystSourceValidation(schema, boundaryArchitecture).parse({ threats: [boundaryCandidate] })
    expect(repaired.threats[0]?.evidenceSources[0]).toMatchObject({ sourceName: 'SRC-0001' })
    expect(withAnalystSourceValidation(schema, boundaryArchitecture).safeParse({ threats: [{
      ...boundaryCandidate,
      evidenceSources: [{ sourceType: 'architecture', sourceName: 'B99', excerpt: 'Unknown boundary' }],
    }] }).success).toBe(false)
  })

  it('does not invent an original-source requirement for historical architectures', () => {
    expect(withAnalystSourceValidation(schema, {} as ArchitectureData)).toBe(schema)
  })

  it('feeds the source error back through the existing bounded structured retry', async () => {
    const calls: string[] = []
    const model = { invoke: async (messages: unknown) => {
      calls.push(JSON.stringify(messages))
      return { content: JSON.stringify({ threats: [calls.length === 1
        ? { ...candidate, evidenceSources: [{ sourceType: 'architecture', sourceName: 'architecture', excerpt: 'ReviewDesk does not protect its review workflow.' }] }
        : candidate] }) }
    } } as unknown as BaseChatModel
    const result = await invokeStructuredWithRetry({ llm: model, schema: checked,
      systemPrompt: 'Verify original quotations.', userMessage: `[SRC-0001] ${quote}`,
      agentName: 'SourceRetryTest', maxRetries: 2 })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('Cite a catalog passage identifier')
    expect(calls[1]).toContain(quote)
    expect(result.threats).toEqual([candidate])
  })

  it('retries instead of accepting zero when every emitted candidate was filtered', async () => {
    const calls: string[] = []
    const model = { invoke: async (messages: unknown) => {
      calls.push(JSON.stringify(messages))
      return { content: JSON.stringify({ threats: [calls.length === 1
        ? { ...candidate, evidenceSources: [{ sourceType: 'rag', sourceName: 'General guidance', excerpt: 'Review mistakes happen.' }] }
        : candidate] }) }
    } } as unknown as BaseChatModel
    const result = await invokeStructuredWithRetry({ llm: model, schema: checked,
      systemPrompt: 'Verify original quotations.', userMessage: `[SRC-0001] ${quote}`,
      agentName: 'AllFilteredRetryTest', maxRetries: 2 })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('All generated candidates were rejected')
    expect(result.threats).toEqual([candidate])
  })
})
