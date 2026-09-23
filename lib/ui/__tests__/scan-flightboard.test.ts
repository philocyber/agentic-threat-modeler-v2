import { describe, expect, it } from 'vitest'
import { deriveFlightboardModel } from '@/lib/ui/scan-flightboard'
import type { PhaseMap, PipelineProgressEvent } from '@/lib/ui/progress-phases'

const progress = (
  phase: string,
  status: PipelineProgressEvent['status'],
  timestamp: number,
  count?: number,
): PipelineProgressEvent => ({ phase, status, timestamp, ...(count == null ? {} : { count }) })

describe('scan flightboard model', () => {
  it('starts in discovery and only includes enabled analysts', () => {
    const model = deriveFlightboardModel({
      phases: {},
      enabledAnalysts: ['stride'],
    })

    expect(model.activeStage.id).toBe('discover')
    expect(model.activeStage.state).toBe('running')
    expect(model.activeStage.phases).toEqual(['architecture_parser', 'stride_analyst'])
    expect(model.stages.map((stage) => stage.id)).toEqual(['discover', 'challenge', 'validate'])
  })

  it('moves to challenge after analyst fan-out is terminal, preserving warnings', () => {
    const phases: PhaseMap = {
      architecture_parser: { state: 'done' },
      stride_analyst: { state: 'done', count: 4 },
      pasta_analyst: { state: 'error' },
      attack_tree_analyst: { state: 'done', count: 2 },
      pre_dedup: { state: 'running' },
    }
    const model = deriveFlightboardModel({ phases })

    expect(model.stages[0]?.state).toBe('warning')
    expect(model.activeStage.id).toBe('challenge')
    expect(model.activePhase).toBe('pre_dedup')
  })

  it('derives checkpoint counts and human activity from real progress events', () => {
    const events = [
      progress('architecture_parser', 'done', 1),
      progress('stride_analyst', 'done', 2, 6),
      progress('pasta_analyst', 'done', 3, 4),
      progress('attack_tree_analyst', 'done', 4, 2),
      progress('pre_dedup', 'done', 5, 9),
      progress('debate', 'start', 6),
    ]
    const phases: PhaseMap = {
      architecture_parser: { state: 'done' },
      stride_analyst: { state: 'done', count: 6 },
      pasta_analyst: { state: 'done', count: 4 },
      attack_tree_analyst: { state: 'done', count: 2 },
      pre_dedup: { state: 'done', count: 9 },
      debate: { state: 'running' },
    }
    const model = deriveFlightboardModel({ phases, events })

    expect(model.analystSignals).toBe(12)
    expect(model.distinctCandidates).toBe(9)
    expect(model.activity[0]?.title).toBe('Red / Blue challenge')
    expect(model.activity[1]?.message).toBe('9 distinct candidates kept after normalization.')
  })

})
