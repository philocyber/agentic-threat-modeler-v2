import { describe, expect, it } from 'vitest'
import {
  chunkDebateBatches,
  mergeDebateBatchRounds,
  mergeReplayedDebateRound,
  previousRoundsForBatch,
  candidatesNeedingReplay,
  unresolvedDebateCandidates,
} from '@/lib/agents/debate-batches'
import type { DebateCandidate, DebateRound } from '@/lib/models/types'

const candidate = (draftId: string): DebateCandidate => ({
  draftId,
  component: 'API',
  methodology: 'STRIDE',
  description: `${draftId} description`,
  impact: 'Impact',
  mitigation: 'Fix it',
  confidenceScore: 0.8,
  evidenceSources: [],
})

function assessment(
  draftId: string,
  redVerdict: DebateRound['threatAssessments'][number]['redVerdict'],
  blueVerdict: DebateRound['threatAssessments'][number]['blueVerdict'],
  judgeNotes?: string,
): DebateRound['threatAssessments'][number] {
  return {
    draftId,
    threatDescription: draftId,
    redVerdict,
    blueVerdict,
    finalVerdict: judgeNotes ? 'medium' : redVerdict === 'unavailable' ? 'unresolved' : redVerdict,
    notes: 'reviewed', redNotes: 'Risk requires an uncovered route.', blueNotes: 'Gateway validation is documented; confirm downstream coverage.',
    ...(judgeNotes ? { judgeNotes } : {}),
  }
}

describe('debate batches', () => {
  it('chunks findings into groups of three by default', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(chunkDebateBatches(items)).toEqual([['a', 'b', 'c'], ['d', 'e', 'f'], ['g']])
    expect(chunkDebateBatches(items, 2)).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f'], ['g']])
  })

  it('keeps only the current batch ids in prior-round context', () => {
    const previous: DebateRound[] = [{
      round: 1,
      redTeamArguments: 'red',
      blueTeamArguments: 'blue',
      convergenceSignal: false,
      threatAssessments: [
        assessment('DRAFT-1', 'high', 'high'),
        assessment('DRAFT-2', 'medium', 'low'),
      ],
    }]
    const filtered = previousRoundsForBatch(previous, [candidate('DRAFT-2')])
    expect(filtered[0]?.threatAssessments.map((item) => item.draftId)).toEqual(['DRAFT-2'])
  })

  it('treats agreed labels without a written conclusion as still open', () => {
    const round: DebateRound = {
      round: 1,
      redTeamArguments: 'red',
      blueTeamArguments: 'blue',
      convergenceSignal: false,
      threatAssessments: [
        assessment('DRAFT-1', 'high', 'high'),
        assessment('DRAFT-2', 'high', 'low', 'judge settled this'),
        assessment('DRAFT-3', 'high', 'low'),
      ],
    }
    expect(unresolvedDebateCandidates(
      [candidate('DRAFT-1'), candidate('DRAFT-2'), candidate('DRAFT-3')],
      round,
    ).map((item) => item.draftId)).toEqual(['DRAFT-1', 'DRAFT-3'])
  })

  it('replays only disagreed or quality-failed cards when agreement is not replayed', () => {
    const round: DebateRound = {
      round: 1,
      redTeamArguments: 'red',
      blueTeamArguments: 'blue',
      convergenceSignal: false,
      threatAssessments: [
        { ...assessment('DRAFT-1', 'high', 'high'), consensus: 'agreed', qualityIssues: [] },
        { ...assessment('DRAFT-2', 'medium', 'low'), consensus: 'disagreed', finalVerdict: 'unresolved', qualityIssues: [] },
        {
          ...assessment('DRAFT-3', 'high', 'high'),
          consensus: 'unverified',
          finalVerdict: 'unresolved',
          qualityIssues: ['Red and Blue returned copied or nearly identical reasoning; independent review is unverified.'],
        },
      ],
    }
    expect(candidatesNeedingReplay(
      [candidate('DRAFT-1'), candidate('DRAFT-2'), candidate('DRAFT-3')],
      round,
    ).map((item) => item.draftId)).toEqual(['DRAFT-2', 'DRAFT-3'])
  })

  it('carries agreed cards into a later round with a Blue close', () => {
    const previous: DebateRound = {
      round: 1,
      isFinalRound: false,
      redTeamArguments: 'red-1',
      blueTeamArguments: 'blue-1',
      convergenceSignal: false,
      threatAssessments: [
        {
          ...assessment('DRAFT-1', 'high', 'high'),
          consensus: 'agreed',
          qualityIssues: [],
          blueNotes: 'JWT validation is documented; confirm this route is in the plugin list.',
        },
        {
          ...assessment('DRAFT-2', 'medium', 'low'),
          consensus: 'disagreed',
          finalVerdict: 'unresolved',
          qualityIssues: [],
        },
      ],
    }
    const live: DebateRound = {
      round: 2,
      isFinalRound: true,
      redTeamArguments: 'red-2',
      blueTeamArguments: 'blue-2',
      convergenceSignal: false,
      judgeSummary: 'settled DRAFT-2',
      threatAssessments: [{
        ...assessment('DRAFT-2', 'medium', 'medium', 'Judge closed the remaining coverage question.'),
        consensus: 'agreed',
        qualityIssues: [],
      }],
    }
    const merged = mergeReplayedDebateRound({
      roundNumber: 2,
      isFinalRound: true,
      orderedDraftIds: ['DRAFT-1', 'DRAFT-2'],
      previous,
      live,
    })
    expect(merged.threatAssessments.map((item) => item.draftId)).toEqual(['DRAFT-1', 'DRAFT-2'])
    expect(merged.threatAssessments[0]?.judgeNotes).toMatch(/^Team conclusion \(agreed\): JWT validation/)
    expect(merged.threatAssessments[1]?.judgeNotes).toBe('Judge closed the remaining coverage question.')
    expect(merged.redTeamArguments).toBe('red-2')
  })

  it('merges parallel batch rounds back into draft order', () => {
    const batchA: DebateRound = {
      round: 1,
      redTeamArguments: 'red-a',
      blueTeamArguments: 'blue-a',
      convergenceSignal: true,
      threatAssessments: [assessment('DRAFT-3', 'medium', 'medium'), assessment('DRAFT-1', 'high', 'high')],
    }
    const batchB: DebateRound = {
      round: 1,
      redTeamArguments: 'red-b',
      blueTeamArguments: 'blue-b',
      convergenceSignal: true,
      judgeSummary: 'route coverage',
      judgeConverged: true,
      threatAssessments: [assessment('DRAFT-2', 'low', 'low')],
    }
    const merged = mergeDebateBatchRounds(1, [batchA, batchB], ['DRAFT-1', 'DRAFT-2', 'DRAFT-3'])
    expect(merged.threatAssessments.map((item) => item.draftId)).toEqual(['DRAFT-1', 'DRAFT-2', 'DRAFT-3'])
    expect(merged.redTeamArguments).toContain('red-a')
    expect(merged.redTeamArguments).toContain('red-b')
    expect(merged.judgeSummary).toBe('route coverage')
    expect(merged.convergenceSignal).toBe(true)
  })
})
