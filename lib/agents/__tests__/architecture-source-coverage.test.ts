import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ArchitectureData } from '@/lib/models/types'
import { assertExtractionCoverage } from '@/lib/architecture/source-evidence'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@/lib/agents/base', () => ({
  invokeWithRetry: invoke,
  mapWithConcurrency: async <T, R>(items: T[], _concurrency: number, fn: (item: T) => Promise<R>) => Promise.all(items.map(fn)),
}))
import { runArchitectureParser } from '@/lib/agents/architecture-parser'

const result: ArchitectureData = {
  systemDescription: 'Export system', components: [{ name: 'LedgerBridge', type: 'service', scope: 'internal' }], dataFlows: [], trustBoundaries: [], externalEntities: [], dataStores: [], apiEndpoints: [], deploymentInfo: '', mermaidDfd: '',
  techFlags: { hasAI: false, hasAuthSystem: true, hasDatabaseLayer: false, hasExternalIntegrations: false, hasFileStorage: true, hasKubernetes: false, hasMessageQueue: false, hasMicroservices: false },
}
const input = Array.from({ length: 6 }, (_, i) => `# Document ${i + 1}\n${`Service${i} section context and qualifications. `.repeat(230)}\nDocument ${i + 1} final rule.\n`).join('\n')

beforeEach(() => { invoke.mockReset(); invoke.mockResolvedValue(result) })
describe('parser source delivery', () => {
  it('sends the whole six-document bundle in one call when it fits', async () => {
    const architecture = await runArchitectureParser({ contextWindow: 131072, outputTokenReserve: 16384 } as unknown as BaseChatModel, input)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0]?.[0].untrusted).toContain('Document 6 final rule.')
    expect(architecture.sourceEvidence?.extraction.mode).toBe('full')
    expect(architecture.sourceEvidence?.sections.map(s => s.text).join('')).toBe(input)
    expect(() => assertExtractionCoverage(architecture)).not.toThrow()
  })
  it('retains failure IDs and blocks downstream work when one source group fails', async () => {
    invoke.mockImplementation(async ({ untrusted }: { untrusted: string }) => {
      if (untrusted.includes('Document 6 final rule.')) throw new Error('simulated extraction failure')
      return result
    })
    const architecture = await runArchitectureParser({ contextWindow: 16384, outputTokenReserve: 4096 } as unknown as BaseChatModel, input)
    expect(architecture.sourceEvidence?.extraction.failed.length).toBeGreaterThan(0)
    expect(architecture.sourceEvidence?.sections.map(s => s.text).join('')).toBe(input)
    expect(() => assertExtractionCoverage(architecture)).toThrow(/coverage blocked/)
  })
  it('never loses source windows across successful section extraction and overview', async () => {
    const architecture = await runArchitectureParser({ contextWindow: 16384, outputTokenReserve: 4096 } as unknown as BaseChatModel, input)
    const delivered = invoke.mock.calls.map(call => String(call[0].untrusted)).join('\n')
    for (const source of architecture.sourceEvidence!.sections) expect(delivered).toContain(source.text)
    expect(architecture.sourceEvidence?.extraction.mode).toBe('sectioned')
    expect(() => assertExtractionCoverage(architecture)).not.toThrow()
  })
})
