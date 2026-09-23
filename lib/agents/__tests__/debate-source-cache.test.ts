import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ArchitectureData, DebateCandidate } from '@/lib/models/types'

const { prepare } = vi.hoisted(() => ({ prepare: vi.fn() }))
vi.mock('../finding-source-context', () => ({ prepareFindingArchitecture: prepare }))

import { runDebateRound } from '../debate'
import { debateProfileFor } from '../debate-profile'

const architecture = {
  systemDescription: 'Review API', components: [], dataFlows: [], trustBoundaries: [],
  externalEntities: [], dataStores: [], apiEndpoints: [], deploymentInfo: '', mermaidDfd: '',
  techFlags: { hasAI: false, hasAuthSystem: true, hasDatabaseLayer: false,
    hasExternalIntegrations: false, hasFileStorage: false, hasKubernetes: false,
    hasMessageQueue: false, hasMicroservices: false },
} as unknown as ArchitectureData

const threat: DebateCandidate = {
  draftId: 'DRAFT-1', component: 'Review API', methodology: 'STRIDE',
  description: 'Authorization coverage needs verification.', impact: 'Incorrect access.',
  mitigation: 'Verify route policy coverage.', confidenceScore: 0.9, evidenceSources: [],
}

beforeEach(() => {
  prepare.mockReset()
  prepare.mockResolvedValue(architecture)
})

describe('debate source-review cache', () => {
  it('reviews a stable candidate batch once across two configured rounds', async () => {
    const model = {
      providerName: 'kimi',
      invoke: async (messages: Array<{ content: unknown }>) => {
        const system = String(messages[0]?.content ?? '')
        const user = String(messages.at(-1)?.content ?? '')
        const reply = user.includes('Round 2')
        const notes = system.includes('Blue Team')
          ? reply
            ? 'Blue accepts the narrowed route-inventory premise; the final open question is whether downstream record policy covers each listed operation.'
            : 'Documented identity validation limits anonymous access, while record policy coverage still requires a route mapping.'
          : reply
            ? 'Red accepts the gateway identity control and narrows residual risk to downstream record permission coverage.'
            : 'Record authorization remains conditional until route mapping is verified against the source policy.'
        return { content: JSON.stringify({ arguments: notes, convergenceSignal: true,
          threatAssessments: [{ draftId: 'DRAFT-1', threatDescription: threat.description,
            notes, applicability: 'conditional', severity: 'medium' }] }) }
      },
    } as unknown as BaseChatModel
    const cache = new Map<string, Promise<ArchitectureData>>()
    const profile = debateProfileFor('kimi')

    const first = await runDebateRound({
      redLLM: model, blueLLM: model, judgeLLM: model, tools: { red: [], blue: [] },
      threats: [threat], previousRounds: [], roundNumber: 1, isFinalRound: false,
      architecture, architectureCache: cache, profile,
    })
    const second = await runDebateRound({
      redLLM: model, blueLLM: model, judgeLLM: model, tools: { red: [], blue: [] },
      threats: [threat], previousRounds: [first], roundNumber: 2, isFinalRound: true,
      architecture, architectureCache: cache, profile,
    })

    expect(prepare).toHaveBeenCalledTimes(1)
    expect(cache.size).toBe(1)
    expect(second.threatAssessments[0]?.judgeNotes).toContain('Team conclusion (agreed)')
  })
})
