import { describe, expect, it } from 'vitest'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { runThreatSynthesizer, synthesisBatchSchema } from '../threat-synthesizer'
import type { ArchitectureData, RawThreat } from '@/lib/models/types'

describe('synthesis planning capacity', () => {
  it('rejects repeated candidate IDs beyond the bounded synthesis merge size', () => {
    const schema = synthesisBatchSchema(['STRIDE-01', 'STRIDE-02'])
    const threat = {
      sourceCandidateIds: Array.from({ length: 5 }, () => 'STRIDE-02'),
      disposition: 'conditional',
      preconditions: [],
      component: 'Gateway',
      methodology: 'STRIDE',
      description: 'The gateway access policy requires verification before unauthorized access can be ruled out for this documented boundary.',
      impact: 'Unauthorized access could expose protected operations.',
      mitigation: 'Verify and enforce the gateway access policy.',
      dread: { damage: 5, reproducibility: 5, exploitability: 5, affectedUsers: 5, discoverability: 5, total: 5 },
      priority: 'medium',
      confidenceScore: 0.6,
    }

    expect(schema.safeParse({ threats: [{ ...threat, sourceCandidateIds: ['STRIDE-01', 'STRIDE-02'] }] }).success).toBe(true)
    expect(schema.safeParse({ threats: [threat] }).success).toBe(false)
  })

  it.each([
    { provider: 'google', window: 131072, source: 'Original architecture.', global: true },
    { provider: 'ollama', window: 32768, source: 'Original architecture. '.repeat(1300), global: false },
  ])('keeps all 50 candidates for $provider using the available context', async ({ provider, window, source, global }) => {
    const planned: string[][] = []
    const emitted: string[] = []
    const emissionBatches: string[][] = []
    const model = {
      providerName: provider, contextWindow: window, outputTokenReserve: 8192,
      invoke: async (messages: Array<{ content: string }>) => {
        const system = messages[0]!.content
        const schema = JSON.parse(system.split('conforms to this JSON Schema:\n')[1]!)
        expect(messages[1]!.content).toContain('Original architecture.')
        if (schema.properties.candidates) {
          const ids = Object.keys(schema.properties.candidates.properties)
          planned.push(ids)
          return { content: JSON.stringify({ candidates: Object.fromEntries(ids.map(id => [id, { decision: 'verify', mergeWith: [], sourceIds: [], note: 'Access policy unknown.' }])), deduplication: '', gaps: '', evidenceGap: '' }) }
        }
        const ids = schema.properties.threats.items.properties.sourceCandidateIds.items.enum as string[]
        expect(schema.properties.threats.items.properties.sourceCandidateIds.maxItems).toBe(4)
        expect(schema.properties.threats.items.properties.evidenceSources).toBeUndefined()
        expect(schema.properties.threats.items.properties.attackTree).toBeUndefined()
        emissionBatches.push(ids)
        emitted.push(...ids)
        return { content: JSON.stringify({ threats: ids.map(id => ({
          sourceCandidateIds: [id], component: `Component ${id}`, methodology: 'STRIDE', disposition: 'conditional', preconditions: ['Verify access policy.'],
          description: `Candidate ${id} requires verification of the access policy on its documented component before concluding that unauthorized access is possible.`,
          impact: 'Unauthorized access', mitigation: 'Verify the policy and enforce required access checks.',
          dread: { damage: 5, reproducibility: 5, exploitability: 5, affectedUsers: 5, discoverability: 5, total: 5 }, priority: 'medium', confidenceScore: 0.6, evidenceSources: [],
        })) }) }
      },
    } as unknown as BaseChatModel
    const candidates: RawThreat[] = Array.from({ length: 50 }, (_, index) => ({ candidateId: `C-${index + 1}`, component: `Component C-${index + 1}`, methodology: index === 0 ? 'ATTACK_TREE' : 'STRIDE',
      description: `Access control verification ${index + 1}`, impact: 'Unauthorized access', mitigation: 'Verify access policy.', confidenceScore: 0.6,
      ...(index === 0 ? { preconditions: ['Verify the documented boundary policy.'] } : {}),
      ...(index === 0 ? { attackTree: { rootGoal: 'Cross the boundary', tree: { goal: 'Cross the boundary', type: 'LEAF' as const }, textRepresentation: 'Cross the boundary' } } : {}),
      evidenceSources: [{ sourceType: 'architecture', sourceName: `SRC-${index + 1}`, excerpt: `Documented component evidence ${index + 1}.` }] }))
    const architecture = { systemDescription: source, components: [], dataFlows: [], trustBoundaries: [], externalEntities: [], dataStores: [], apiEndpoints: [], deploymentInfo: '', mermaidDfd: '' } as unknown as ArchitectureData
    const errors: string[] = []
    const result = await runThreatSynthesizer(model, [], candidates, [], architecture, 15, undefined, undefined, 1, model, error => errors.push(error))
    expect(errors).toEqual([])
    expect(planned.flat()).toEqual(candidates.map(candidate => candidate.candidateId))
    expect(emitted).toEqual(candidates.map(candidate => candidate.candidateId))
    expect(Math.max(...emissionBatches.map(batch => batch.length))).toBeLessThanOrEqual(provider === 'ollama' ? 2 : 4)
    expect(planned.length === 1).toBe(global)
    expect(result).toHaveLength(15)
    expect(result.every(threat => threat.evidenceSources.length > 0)).toBe(true)
    expect(result.find(threat => threat.sourceCandidateIds?.includes('C-1'))?.attackTree?.rootGoal).toBe('Cross the boundary')
    expect(result.find(threat => threat.sourceCandidateIds?.includes('C-1'))?.preconditions).toEqual(['Verify the documented boundary policy.'])
  })
})
