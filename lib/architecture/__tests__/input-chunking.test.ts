import { describe, expect, it } from 'vitest'
import {
  chunkArchitectureInput,
  mergePartialArchitectures,
  resolveArchitectureChunkConcurrency,
  SINGLE_PASS_LIMIT,
  type PartialArchitecture,
} from '@/lib/architecture/input-chunking'

describe('chunkArchitectureInput', () => {
  it('does not split input that already fits one context window', () => {
    const chunks = chunkArchitectureInput('# RFC\n\nA small system description.')

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.text).toContain('A small system description.')
  })

  it('splits a long document on its headings and keeps section titles', () => {
    const section = (title: string) => `# ${title}\n\n${'detail sentence. '.repeat(500)}`
    const input = [section('Architecture'), section('Data Flows'), section('Security Controls')].join('\n\n')

    const chunks = chunkArchitectureInput(input)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((c) => c.heading)).toContain('Architecture')
    expect(chunks.map((c) => c.heading)).toContain('Security Controls')
    expect(chunks.every((c) => c.text.length <= 14_000)).toBe(true)
  })

  it('covers the whole input — nothing is silently dropped', () => {
    const input = Array.from({ length: 40 }, (_, i) => `## Section ${i}\n\n${'x'.repeat(900)}`).join('\n\n')
    const chunks = chunkArchitectureInput(input)

    for (let i = 0; i < 40; i += 1) {
      expect(chunks.some((chunk) => chunk.text.includes(`Section ${i}`))).toBe(true)
    }
  })

  it('splits a single oversized section with no headings at all', () => {
    const chunks = chunkArchitectureInput('y'.repeat(SINGLE_PASS_LIMIT * 3))

    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every((chunk) => chunk.text.length <= 14_000)).toBe(true)
  })

  it('indexes chunks in document order', () => {
    const input = Array.from({ length: 10 }, (_, i) => `# H${i}\n\n${'z'.repeat(3_000)}`).join('\n\n')
    const chunks = chunkArchitectureInput(input)

    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, i) => i))
  })
})

describe('resolveArchitectureChunkConcurrency', () => {
  it('keeps Ollama sequential regardless of the override', () => {
    expect(resolveArchitectureChunkConcurrency('ollama', 14, 8)).toBe(1)
  })

  it('uses bounded concurrency for hosted providers', () => {
    expect(resolveArchitectureChunkConcurrency('kimi', 14)).toBe(2)
    expect(resolveArchitectureChunkConcurrency('google', 2)).toBe(2)
    expect(resolveArchitectureChunkConcurrency('kimi', 14, 4)).toBe(4)
  })
})

describe('mergePartialArchitectures', () => {
  const first: PartialArchitecture = {
    systemDescription: 'Frontend section.',
    components: [{ name: 'Kong Gateway', type: 'gateway', scope: 'dmz' }],
    dataFlows: [{ from: 'User', to: 'Kong', data: 'credentials' }],
    trustBoundaries: ['TB-1'],
    dataStores: ['Postgres'],
    apiEndpoints: ['POST /login'],
    techFlags: { hasAuthSystem: true, hasAI: false },
    detailedTopology: {
      securityConfigs: [{ component: 'Kong', configType: 'plugin', isEnabled: true, details: 'jwt' }],
    },
  }
  const second: PartialArchitecture = {
    systemDescription: 'Backend section.',
    components: [
      { name: 'kong gateway', type: 'gateway', scope: 'dmz', technology: 'Kong 3.2' },
      { name: 'Payments API', type: 'backend', scope: 'internal' },
    ],
    dataFlows: [{ from: 'User', to: 'Kong', data: 'credentials' }],
    trustBoundaries: ['TB-1', 'TB-2'],
    apiEndpoints: ['POST /payments'],
    techFlags: { hasAI: true },
    detailedTopology: {
      securityConfigs: [{ component: 'Kong', configType: 'plugin', isEnabled: true, details: 'jwt' }],
    },
  }

  it('unions components by name and prefers the richer record', () => {
    const merged = mergePartialArchitectures([first, second])

    expect(merged.components).toHaveLength(2)
    expect(merged.components?.find((c) => /kong/i.test(c.name))?.technology).toBe('Kong 3.2')
  })

  it('deduplicates identical data flows and security configs', () => {
    const merged = mergePartialArchitectures([first, second])

    expect(merged.dataFlows).toHaveLength(1)
    expect(merged.detailedTopology?.securityConfigs).toHaveLength(1)
  })

  it('ORs tech flags across sections', () => {
    const merged = mergePartialArchitectures([first, second])

    expect(merged.techFlags?.hasAI).toBe(true)
    expect(merged.techFlags?.hasAuthSystem).toBe(true)
  })

  it('keeps every endpoint and boundary exactly once', () => {
    const merged = mergePartialArchitectures([first, second])

    expect(merged.apiEndpoints).toEqual(['POST /login', 'POST /payments'])
    expect(merged.trustBoundaries).toEqual(['TB-1', 'TB-2'])
  })

  it('is order-stable and idempotent for the same inputs', () => {
    const once = mergePartialArchitectures([first, second])
    const twice = mergePartialArchitectures([first, second])

    expect(twice).toEqual(once)
  })
})
