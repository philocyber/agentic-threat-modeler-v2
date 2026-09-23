import { describe, expect, it } from 'vitest'
import { derivePhases } from '@/lib/ui/progress-phases'

const event = (
  phase: string,
  status: 'start' | 'done' | 'error',
  timestamp: number,
) => ({ phase, status, timestamp })

describe('pipeline progress phase ordering', () => {
  it('hides dedup and downstream phases until every enabled analyst is terminal', () => {
    const phases = derivePhases([
      event('architecture_parser', 'done', 1),
      event('stride_analyst', 'start', 2),
      event('pasta_analyst', 'done', 3),
      event('attack_tree_analyst', 'start', 4),
      event('pre_dedup', 'done', 5),
      event('debate', 'done', 6),
      event('threat_synthesizer', 'start', 7),
    ])

    expect(phases.stride_analyst?.state).toBe('running')
    expect(phases.pre_dedup).toBeUndefined()
    expect(phases.debate).toBeUndefined()
    expect(phases.threat_synthesizer).toBeUndefined()
  })

  it('treats analyst errors as terminal without presenting them as success', () => {
    const phases = derivePhases([
      event('architecture_parser', 'done', 1),
      event('stride_analyst', 'error', 2),
      event('pasta_analyst', 'done', 3),
      event('attack_tree_analyst', 'error', 4),
      event('pre_dedup', 'start', 5),
    ])

    expect(phases.stride_analyst?.state).toBe('error')
    expect(phases.attack_tree_analyst?.state).toBe('error')
    expect(phases.pre_dedup?.state).toBe('running')
  })

  it('does not let late duplicate start events downgrade a completed phase', () => {
    const phases = derivePhases([
      event('architecture_parser', 'done', 1),
      event('architecture_parser', 'start', 2),
    ])
    expect(phases.architecture_parser?.state).toBe('done')
  })

})
