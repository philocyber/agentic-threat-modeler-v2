import { describe, expect, it } from 'vitest'
import type { AnalysisConfig } from '@/lib/db/schema'
import {
  createRunManifest,
  incompatibleManifestCategories,
  isRunManifestV2,
  manifestModelSettings,
} from '../run-manifest'
import { getConfig } from '@/lib/config'

const config: AnalysisConfig = {
  provider: 'ollama',
  enabledAnalysts: ['stride', 'pasta'],
  executionMode: 'hybrid',
  maxDebateRounds: 2,
  targetThreats: 12,
  requireEvidenceForHighPriority: true,
  useRag: true,
}

function manifest(overrides: Partial<Parameters<typeof createRunManifest>[0]> = {}) {
  return createRunManifest({
    inputFingerprint: 'input-a',
    systemId: 'system-a',
    config,
    ragIndexFingerprint: 'index-a',
    ...overrides,
  })
}

describe('run manifest v2', () => {
  it('invalidates checkpoints when the selected provider output budget changes', () => {
    const app = getConfig()
    const previous = manifest({ modelSettings: manifestModelSettings(app, config) })
    const changed = { ...app, llm: { ...app.llm, ollamaDeepMaxTokens: app.llm.ollamaDeepMaxTokens + 1 } }
    const current = manifest({ modelSettings: manifestModelSettings(changed, config) })
    expect(incompatibleManifestCategories(previous, current)).toEqual(['models'])
  })

  it('does not invalidate local checkpoints for an unrelated cloud output budget', () => {
    const app = getConfig()
    const previous = manifest({ modelSettings: manifestModelSettings(app, config) })
    const changed = { ...app, llm: { ...app.llm, kimiDeepMaxTokens: app.llm.kimiDeepMaxTokens + 1 } }
    expect(manifest({ modelSettings: manifestModelSettings(changed, config) })).toEqual(previous)
  })

  it('is deterministic across object key ordering', () => {
    const first = manifest()
    const second = manifest({ config: { ...config } })
    expect(second).toEqual(first)
    expect(isRunManifestV2(first)).toBe(true)
  })

  it('reports only the incompatible categories', () => {
    const previous = manifest()
    const current = manifest({
      inputFingerprint: 'input-b',
      config: { ...config, provider: 'kimi', quickModel: 'kimi-k2.6' },
    })
    expect(incompatibleManifestCategories(previous, current)).toEqual(['input', 'models'])
  })

  it('rejects missing categories and a forged fingerprint', () => {
    const valid = manifest()
    expect(isRunManifestV2({ ...valid, fingerprint: '0'.repeat(64) })).toBe(false)
    const categories: Partial<typeof valid.categories> = { ...valid.categories }
    delete categories.input
    expect(isRunManifestV2({ ...valid, categories })).toBe(false)
  })
})
