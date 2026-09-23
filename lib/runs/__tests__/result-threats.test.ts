import { describe, expect, it } from 'vitest'
import type { UnifiedThreat } from '@/lib/models/types'
import { resolveResultThreats } from '@/lib/runs/result-threats'

function threat(id: string, title: string): UnifiedThreat {
  return {
    id,
    title,
    description: title,
    component: 'API',
    impact: 'Impact',
    mitigation: 'Mitigation',
    methodology: 'STRIDE',
    dread: { damage: 5, reproducibility: 5, exploitability: 5, affectedUsers: 5, discoverability: 5, total: 5 },
    priority: 'medium',
    confidenceScore: 0.8,
    evidenceSources: [],
  }
}

describe('resolveResultThreats', () => {
  it('prefers relational rows when both sources exist', () => {
    const resolved = resolveResultThreats([threat('db-1', 'Database')], [threat('artifact-1', 'Artifact')])
    expect(resolved.source).toBe('database')
    expect(resolved.threats.map((item) => item.title)).toEqual(['Database'])
  })

  it('recovers a completed legacy run from its final artifact', () => {
    const resolved = resolveResultThreats([], [threat('artifact-1', 'Recovered')])
    expect(resolved.source).toBe('artifact')
    expect(resolved.threats[0]).toMatchObject({ title: 'Recovered', displayId: 'WEB-01' })
  })
})
