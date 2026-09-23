import { describe, expect, it } from 'vitest'
import { debateProfileFor } from '../debate-profile'

describe('debateProfileFor', () => {
  it('uses a conservative, quality-first workflow for local Ollama inference', () => {
    expect(debateProfileFor('ollama')).toMatchObject({
      candidateCap: 8,
      batchSize: 3,
      batchConcurrency: 1,
      evidenceMode: 'two_phase',
      judgeCoverage: 'all',
      interimConclusions: true,
      verifyRepairs: true,
      copyContainment: 0.5,
    })
  })

  it('uses wider serial batches with embedded evidence for Kimi', () => {
    const profile = debateProfileFor('kimi')
    expect(profile).toMatchObject({
      candidateCap: 25,
      batchSize: 5,
      batchConcurrency: 1,
      evidenceMode: 'embedded',
      judgeCoverage: 'contested',
      interimConclusions: false,
      verifyRepairs: false,
    })
    expect(profile.outputTokenReserve).toBeUndefined()
  })

  it('uses wide concurrent batches and reserves output context for Cursor', () => {
    expect(debateProfileFor('cursor')).toMatchObject({
      candidateCap: 25,
      batchSize: 5,
      batchConcurrency: 3,
      evidenceMode: 'embedded',
      judgeCoverage: 'all',
      verifyRepairs: true,
      replayAgreedFindings: false,
      outputTokenReserve: 4_096,
    })
  })

  it('falls back to the hosted baseline for providers without an override', () => {
    expect(debateProfileFor('google')).toEqual({
      candidateCap: 25,
      batchSize: 3,
      batchConcurrency: 3,
      evidenceMode: 'two_phase',
      judgeCoverage: 'all',
      interimConclusions: false,
      verifyRepairs: false,
      replayAgreedFindings: true,
      copyContainment: 0.5,
    })
  })

  it('returns an independent profile object for every run', () => {
    const first = debateProfileFor('ollama')
    first.batchSize = 99

    expect(debateProfileFor('ollama').batchSize).toBe(3)
  })
})
