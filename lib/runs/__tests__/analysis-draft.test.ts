import { describe, expect, it } from 'vitest'
import { parseAnalysisDraft } from '@/lib/runs/analysis-draft'

describe('analysis draft persistence', () => {
  it('restores all submission-relevant form fields', () => {
    expect(parseAnalysisDraft(JSON.stringify({
      schemaVersion: 1,
      systemName: 'Checkout API',
      systemId: 'system-123',
      input: 'Browser -> API -> database',
      inputType: 'file',
      selectedPreviousRun: 'run-456',
      sourceRunId: 'run-456',
      config: {
        provider: 'google',
        allowedProviders: ['google'],
        executionProfile: 'provider_full_power',
        allowedProfiles: ['provider_full_power'],
        quickModel: 'gemini-quick',
        deepModel: 'gemini-deep',
        enabledAnalysts: ['stride', 'attack_tree'],
        executionMode: 'cascade',
        maxDebateRounds: 4,
        targetThreats: 20,
        requireEvidenceForHighPriority: true,
        useRag: false,
      },
    }))).toEqual({
      schemaVersion: 1,
      systemName: 'Checkout API',
      systemId: 'system-123',
      input: 'Browser -> API -> database',
      inputType: 'file',
      selectedPreviousRun: 'run-456',
      sourceRunId: 'run-456',
      config: {
        provider: 'google',
        allowedProviders: ['google'],
        executionProfile: 'provider_full_power',
        allowedProfiles: ['provider_full_power'],
        quickModel: 'gemini-quick',
        deepModel: 'gemini-deep',
        enabledAnalysts: ['stride', 'attack_tree'],
        executionMode: 'cascade',
        maxDebateRounds: 4,
        targetThreats: 20,
        requireEvidenceForHighPriority: true,
        useRag: false,
      },
    })
  })

  it('rejects malformed and obsolete drafts', () => {
    expect(parseAnalysisDraft('{not-json')).toBeNull()
    expect(parseAnalysisDraft(JSON.stringify({ schemaVersion: 2 }))).toBeNull()
    expect(parseAnalysisDraft(JSON.stringify({
      schemaVersion: 1,
      systemName: 'API',
      input: 'context',
      inputType: 'binary',
      selectedPreviousRun: '',
      config: {},
    }))).toBeNull()
    expect(parseAnalysisDraft(JSON.stringify({
      schemaVersion: 1,
      systemName: 'API',
      input: 'context',
      inputType: 'text',
      selectedPreviousRun: '',
      sourceRunId: 123,
      config: {},
    }))).toBeNull()
  })

  it('drops invalid config values from a valid draft', () => {
    const draft = parseAnalysisDraft(JSON.stringify({
      schemaVersion: 1,
      systemName: '',
      input: '',
      inputType: 'text',
      selectedPreviousRun: '',
      config: {
        provider: 'unknown',
        enabledAnalysts: ['stride', 'invented'],
        executionMode: 'random',
      },
    }))

    expect(draft?.config).toEqual({ enabledAnalysts: ['stride'] })
  })
})
