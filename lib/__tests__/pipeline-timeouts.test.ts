import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PIPELINE_PHASE_TIMEOUT_MS,
  DEFAULT_PIPELINE_TIMEOUT_MS,
  resolvePipelineTimeouts,
  sourcePhaseTimeoutMs,
  batchedPhaseTimeoutMs,
} from '@/lib/pipeline-timeouts'

describe('resolvePipelineTimeouts', () => {
  it('budgets serial debate batches without multiplying concurrent work or extending the global ceiling', () => {
    expect(batchedPhaseTimeoutMs(900_000, 4, 1, 5_400_000)).toBe(3_600_000)
    expect(batchedPhaseTimeoutMs(900_000, 4, 3, 5_400_000)).toBe(1_800_000)
    expect(batchedPhaseTimeoutMs(900_000, 2, 3, 5_400_000)).toBe(900_000)
    expect(batchedPhaseTimeoutMs(900_000, 8, 1, 5_400_000)).toBe(5_400_000)
    expect(batchedPhaseTimeoutMs(900_000, 0, 0, 5_400_000)).toBe(900_000)
  })
  it('allows complete multi-pass work within the unchanged global deadline', () => {
    expect(sourcePhaseTimeoutMs(900_000, 1, 5_400_000)).toBe(900_000)
    expect(sourcePhaseTimeoutMs(900_000, 3, 5_400_000)).toBe(2_700_000)
    expect(sourcePhaseTimeoutMs(900_000, 13, 5_400_000)).toBe(5_400_000)
    expect(sourcePhaseTimeoutMs(900_000, Number.NaN, 5_400_000)).toBe(900_000)
  })
  it('uses budgets that accommodate hosted reasoning runs', () => {
    expect(resolvePipelineTimeouts({})).toEqual({
      pipelineTimeoutMs: DEFAULT_PIPELINE_TIMEOUT_MS,
      phaseTimeoutMs: DEFAULT_PIPELINE_PHASE_TIMEOUT_MS,
    })
  })

  it('caps the phase budget at the global pipeline budget', () => {
    expect(resolvePipelineTimeouts({
      PIPELINE_TIMEOUT_MS: '600000',
      PIPELINE_PHASE_TIMEOUT_MS: '900000',
    })).toEqual({ pipelineTimeoutMs: 600000, phaseTimeoutMs: 600000 })
  })

  it('falls back for invalid environment values', () => {
    expect(resolvePipelineTimeouts({
      PIPELINE_TIMEOUT_MS: 'NaN',
      PIPELINE_PHASE_TIMEOUT_MS: '-1',
    })).toEqual({
      pipelineTimeoutMs: DEFAULT_PIPELINE_TIMEOUT_MS,
      phaseTimeoutMs: DEFAULT_PIPELINE_PHASE_TIMEOUT_MS,
    })
  })
})
