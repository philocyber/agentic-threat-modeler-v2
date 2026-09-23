import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ArchitectureData } from '@/lib/models/types'
import { createSourceEvidence } from '@/lib/architecture/source-evidence'
import { prepareFindingArchitecture } from '../finding-source-context'

const { classify } = vi.hoisted(() => ({ classify: vi.fn() }))
vi.mock('@/lib/agents/base', () => ({ invokeStructuredWithRetry: classify }))

const model = { contextWindow: 32768, outputTokenReserve: 8192 } as unknown as BaseChatModel
function fixture(large = true): ArchitectureData {
  const sourceEvidence = createSourceEvidence(Array.from({ length: large ? 30 : 1 }, (_, i) =>
    `# LedgerBridge section ${i}\n${`Unrelated LedgerBridge operational detail ${i}. `.repeat(55)}\n`).join('\n'))
  sourceEvidence.extraction.attempted = sourceEvidence.sections.map(section => section.id)
  return { systemDescription: 'LedgerBridge', components: [], dataFlows: [], trustBoundaries: [], externalEntities: [], dataStores: [], apiEndpoints: [], deploymentInfo: '', mermaidDfd: '', techFlags: { hasAI: false, hasAuthSystem: true, hasDatabaseLayer: false, hasExternalIntegrations: false, hasFileStorage: false, hasKubernetes: false, hasMessageQueue: false, hasMicroservices: false }, sourceEvidence }
}
function ids(message: string) { return [...message.matchAll(/\[(SRC-\d+)\]/g)].map(match => match[1]!) }
beforeEach(() => { classify.mockReset() })

describe('finding source context', () => {
  it('reviews every section and retains full citations, adjacent qualifications and uncertainty', async () => {
    const architecture = fixture()
    const sections = architecture.sourceEvidence!.sections
    const finding = { component: 'LedgerBridge', evidenceSources: [{ sourceName: sections[1]!.id, excerpt: sections[1]!.text.slice(0, 60) }] }
    const uncertain = sections[20]!.id
    classify.mockImplementation(async ({ userMessage }) => ({ sections: ids(userMessage).map(sourceId => ({
      sourceId, relevance: sourceId === uncertain ? 'uncertain' : 'irrelevant',
    })) }))
    const result = await prepareFindingArchitecture(architecture, [finding], model)
    expect(classify.mock.calls.length).toBeGreaterThan(1)
    expect(classify.mock.calls.flatMap(([params]) => ids(params.userMessage))).toEqual(sections.map(section => section.id))
    expect(result.sourceEvidence!.sections).toEqual([sections[0], sections[1], sections[2], sections[19], sections[20], sections[21]])
    expect(architecture.sourceEvidence!.sections).toHaveLength(sections.length)
  })

  it('rejects an omitted classification rather than treating it as irrelevant', async () => {
    classify.mockImplementation(async ({ userMessage }) => ({ sections: ids(userMessage).slice(1).map(sourceId => ({ sourceId, relevance: 'irrelevant' })) }))
    await expect(prepareFindingArchitecture(fixture(), [{ component: 'LedgerBridge' }], model)).rejects.toThrow('exactly once')
  })

  it('does not clip retained evidence when all sections remain relevant or uncertain', async () => {
    classify.mockImplementation(async ({ userMessage }) => ({ sections: ids(userMessage).map(sourceId => ({ sourceId, relevance: 'uncertain' })) }))
    await expect(prepareFindingArchitecture(fixture(), [{ component: 'LedgerBridge' }], model)).rejects.toThrow('no required passages were removed')
  })

  it('uses the existing complete-source path when it fits without an extra model call', async () => {
    const architecture = fixture(false)
    expect(await prepareFindingArchitecture(architecture, [{ component: 'LedgerBridge' }], model)).toBe(architecture)
    expect(classify).not.toHaveBeenCalled()
  })

  it('respects cancellation before issuing a review request', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(prepareFindingArchitecture(fixture(), [{ component: 'LedgerBridge' }], model, controller.signal)).rejects.toThrow()
    expect(classify).not.toHaveBeenCalled()
  })
})
