import { describe, expect, it } from 'vitest'
import {
  debateVerdictFingerprint,
  hasDebateConverged,
} from '@/lib/agents/debate-convergence'
import { wireAnalystEdges } from '@/lib/graph/execution-mode'
import { mapThreatsForWebhook } from '@/lib/webhooks/payload'
import type { DebateRound, UnifiedThreat } from '@/lib/models/types'

function assessment(
  description: string,
  finalVerdict: Exclude<DebateRound['threatAssessments'][number]['finalVerdict'], 'unresolved'>,
): DebateRound['threatAssessments'][number] {
  return {
    draftId: `DRAFT-${description}`,
    threatDescription: description,
    redVerdict: finalVerdict,
    blueVerdict: finalVerdict,
    finalVerdict,
    notes: 'reviewed', redNotes: 'Risk requires an uncovered route.', blueNotes: 'Gateway validation is documented; confirm downstream coverage.',
  }
}

function round(
  n: number,
  assessments: DebateRound['threatAssessments'],
  convergenceSignal = false,
): DebateRound {
  return {
    round: n,
    redTeamArguments: 'red',
    blueTeamArguments: 'blue',
    convergenceSignal,
    threatAssessments: assessments,
  }
}

describe('debate convergence policy', () => {
  it('fingerprints verdicts stably regardless of assessment order', () => {
    const a = debateVerdictFingerprint([
      assessment('SQL injection', 'high'),
      assessment('IDOR', 'medium'),
    ])
    const b = debateVerdictFingerprint([
      assessment('IDOR', 'medium'),
      assessment('SQL injection', 'high'),
    ])
    expect(a).toBe(b)
  })

  it('stops when consecutive rounds have identical verdicts', () => {
    const assessments = [assessment('SQL injection in login', 'high')]
    const rounds = [round(1, assessments), round(2, assessments)]
    expect(hasDebateConverged(rounds)).toBe(true)
  })

  it('stops on explicit convergence signal from round 2+', () => {
    const rounds = [
      round(1, [assessment('A', 'critical')]),
      round(2, [assessment('A', 'high')], true),
    ]
    expect(hasDebateConverged(rounds)).toBe(true)
  })

  it('stops at round 1 when every finding is agreed or judged', () => {
    expect(hasDebateConverged([round(1, [assessment('A', 'high')], true)])).toBe(true)
  })

  it('does not stop at round 1 on a self-reported signal while findings remain contested', () => {
    const contested: DebateRound['threatAssessments'][number] = {
      ...assessment('A', 'high'),
      redVerdict: 'high',
      blueVerdict: 'low',
      finalVerdict: 'high',
    }
    expect(hasDebateConverged([round(1, [contested], true)])).toBe(false)
    expect(hasDebateConverged([round(1, [contested], true), round(2, [contested], true)])).toBe(false)
  })

  it('never treats repeated copied reasoning or an earlier unresolved candidate as convergence', () => {
    const copied = { ...assessment('A', 'invalid'), redNotes: 'This scenario is not supported by the source.', blueNotes: 'This scenario is not supported by the source.' }
    expect(hasDebateConverged([round(1, [copied], true), round(2, [copied], true)])).toBe(false)
    expect(hasDebateConverged([round(1, [copied]), round(2, [assessment('B', 'low')], true)])).toBe(false)
  })
})

describe('wireAnalystEdges', () => {
  it('wires cascade sequentially', () => {
    const edges: Array<[string | string[], string]> = []
    const g = {
      addEdge(from: string | string[], to: string) {
        edges.push([from, to])
      },
    }
    wireAnalystEdges(g, 'cascade')
    expect(edges).toEqual([
      ['architecture_parser', 'stride_analyst'],
      ['stride_analyst', 'pasta_analyst'],
      ['pasta_analyst', 'attack_tree_analyst'],
      ['attack_tree_analyst', 'pre_dedup'],
    ])
  })

  it('wires hybrid as stride then parallel pasta/trees', () => {
    const edges: Array<[string | string[], string]> = []
    const g = {
      addEdge(from: string | string[], to: string) {
        edges.push([from, to])
      },
    }
    wireAnalystEdges(g, 'hybrid')
    expect(edges).toContainEqual(['architecture_parser', 'stride_analyst'])
    expect(edges).toContainEqual(['stride_analyst', 'pasta_analyst'])
    expect(edges).toContainEqual(['stride_analyst', 'attack_tree_analyst'])
    expect(edges).toContainEqual([['pasta_analyst', 'attack_tree_analyst'], 'pre_dedup'])
    expect(edges).not.toContainEqual(['pasta_analyst', 'pre_dedup'])
    expect(edges).not.toContainEqual(['attack_tree_analyst', 'pre_dedup'])
  })

  it('wires parallel fan-out followed by one wait-for-all barrier', () => {
    const edges: Array<[string | string[], string]> = []
    const g = {
      addEdge(from: string | string[], to: string) {
        edges.push([from, to])
      },
    }
    wireAnalystEdges(g, 'parallel')
    expect(edges.filter(([f]) => f === 'architecture_parser')).toHaveLength(3)
    expect(edges).toContainEqual([
      ['stride_analyst', 'pasta_analyst', 'attack_tree_analyst'],
      'pre_dedup',
    ])
    expect(edges.filter(([, to]) => to === 'pre_dedup')).toHaveLength(1)
  })
})

describe('webhook methodology_data', () => {
  it('embeds attack tree and PASTA fields under methodology_data', () => {
    const threat: UnifiedThreat = {
      id: 't1',
      component: 'API',
      methodology: 'PASTA',
      description: 'Attacker exploits missing auth on admin endpoint',
      impact: 'impact',
      mitigation: 'mitigation',
      dread: { damage: 8, reproducibility: 7, exploitability: 7, affectedUsers: 8, discoverability: 6, total: 7.2 },
      priority: 'high',
      confidenceScore: 0.9,
      evidenceSources: [],
      attackerProfile: 'external attacker',
      attackVector: 'HTTP',
      attackTree: {
        rootGoal: 'Take over admin',
        tree: { goal: 'bypass auth', type: 'LEAF' },
        textRepresentation: 'bypass auth',
      },
    }
    const [mapped] = mapThreatsForWebhook([threat])
    expect(mapped?.methodology_data.attackerProfile).toBe('external attacker')
    expect(mapped?.methodology_data.attackTree?.rootGoal).toBe('Take over admin')
  })
})
