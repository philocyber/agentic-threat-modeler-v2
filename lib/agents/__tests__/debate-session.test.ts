import { describe, expect, it, vi } from 'vitest'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { DebateCandidate, DebateRound } from '@/lib/models/types'
import { runDebateRound, RED_EMISSION_PROMPT, BLUE_EMISSION_PROMPT, RED_REPLY_EMISSION_PROMPT, BLUE_REPLY_EMISSION_PROMPT } from '../debate'
import { runDebateSession } from '../debate-session'
import { formatDebateRoundsMarkdown, parseStoredDebateRounds } from '../debate-format'
import { hasDebateConverged, isDebateFindingResolved } from '../debate-convergence'

const candidates: DebateCandidate[] = ['DRAFT-1', 'DRAFT-2'].map(draftId => ({
  draftId, component: 'Review API', methodology: 'STRIDE', confidenceScore: 0.8,
  description: 'Record permissions require verification.', impact: 'Incorrect access.',
  mitigation: 'Verify the route policy.', evidenceSources: [],
}))
const redNotes = [
  'Source shows a conditional permission risk.',
  'I accept authentication, but record authorization remains undocumented.',
  'Blue’s policy scope narrows the hypothesis to unlisted routes.',
  'With route scope still unknown, I retain a conditional assessment.',
]
const blueNotes = [
  'Authentication is enforced; route coverage requires verification.',
  'Red correctly distinguishes identity from resource permission; verify the policy.',
  'That narrower scenario depends on route inventory completeness.',
  'I accept that dependency and maintain the need for coverage evidence.',
]

function fixture(params: { finalBlueDisagrees?: boolean; repeatsBlue?: boolean } = {}) {
  const turns: string[] = []
  const contexts: Array<{ team: string; round: number; user: string }> = []
  const model = { invoke: async (messages: Array<{ content: unknown }>) => {
    const system = String(messages[0]?.content)
    const user = String(messages.at(-1)?.content)
    const round = Number(/Round (\d+)/.exec(user)?.[1])
    const team = [RED_EMISSION_PROMPT, RED_REPLY_EMISSION_PROMPT].some(prompt => system.includes(prompt)) ? 'Red'
      : [BLUE_EMISSION_PROMPT, BLUE_REPLY_EMISSION_PROMPT].some(prompt => system.includes(prompt)) ? 'Blue' : null
    if (system.includes('independent security judge')) {
      const ids = [...new Set(user.match(/DRAFT-\d+/g) ?? [])]
      return { content: JSON.stringify({
        summary: 'Each finding is closed against the source.',
        convergenceSignal: !params.finalBlueDisagrees,
        threatAssessments: ids.map(draftId => ({
          draftId,
          threatDescription: 'Record permissions',
          applicability: 'conditional',
          severity: params.finalBlueDisagrees && round === 2 ? 'medium' : 'high',
          notes: `${draftId}: record permission coverage remains the verification question after both teams reviewed the Review API source.`,
        })),
      }) }
    }
    if (!team) return { content: 'Independent source review notes: verify record policy coverage.' }
    if (!user.includes('repair ONLY')) {
      turns.push(`${team}${round}`)
      contexts.push({ team, round, user })
    }
    const ids = [...new Set(user.match(/DRAFT-\d+/g))]
    return { content: JSON.stringify({ arguments: `${team} turn ${round}`, convergenceSignal: true,
      threatAssessments: ids.map(draftId => ({ draftId, threatDescription: 'Record permissions',
        applicability: 'conditional', severity: params.finalBlueDisagrees && team === 'Blue' && round === 2 ? 'low' : 'high',
        notes: team === 'Red' ? redNotes[round - 1] : blueNotes[params.repeatsBlue ? 0 : round - 1],
      })) }) }
  } } as unknown as BaseChatModel
  // judgeLLM was missing here while the fake model already implemented a judge
  // branch, so "judge settles the disagreement" asserted against a debate that
  // never ran one. The adjudicator is wired in so the assertions exercise it.
  const runRound = (number: number, previous: DebateRound[], final: boolean) => runDebateRound({
    redLLM: model, blueLLM: model, judgeLLM: model, tools: { red: [], blue: [] }, threats: candidates,
    previousRounds: previous, roundNumber: number, isFinalRound: final, batchConcurrency: 1,
  })
  return { turns, contexts, runRound }
}

describe('configured debate dialogue', () => {
  it.each([1, 2, 3, 4])('%i rounds give every candidate exactly that many turns per team, even with early agreement', async roundCount => {
    const fixtureCase = fixture()
    const checkpoints: number[] = []
    const rounds = await runDebateSession({ roundCount, runRound: fixtureCase.runRound,
      onRound: async completed => { checkpoints.push(completed.length) } })
    expect(fixtureCase.turns).toEqual(Array.from({ length: roundCount }, (_, i) => [`Red${i + 1}`, `Blue${i + 1}`]).flat())
    expect(checkpoints).toEqual(Array.from({ length: roundCount }, (_, i) => i + 1))
    expect(rounds).toHaveLength(roundCount)
    for (const round of rounds) {
      expect(round.threatAssessments.map(item => item.draftId)).toEqual(['DRAFT-1', 'DRAFT-2'])
      expect(round.threatAssessments.every(item => !item.redReplyNotes)).toBe(true)
      expect(round.threatAssessments.every(item => !item.qualityIssues?.length)).toBe(true)
      expect(round.convergenceSignal).toBe(round.round === roundCount)
    }
    const report = parseStoredDebateRounds(formatDebateRoundsMarkdown(rounds, []), [])
    expect(report).toHaveLength(roundCount)
    expect(report.every(round => round.findings.length === 2)).toBe(true)
    expect(report.at(-1)?.findings[0]?.blueNotes).toBe(blueNotes[roundCount - 1])
    expect(report.slice(0, -1).every(round => round.isFinalRound === false)).toBe(true)
    if (roundCount > 1) {
      expect(fixtureCase.contexts.find(call => call.team === 'Red' && call.round === 2)?.user).toContain(blueNotes[0])
      const blueReply = fixtureCase.contexts.find(call => call.team === 'Blue' && call.round === 2)
      expect(blueReply?.user).toContain(redNotes[1])
      expect(blueReply?.user).toContain(blueNotes[0])
    }
  })

  it('does not declare consensus using Blue’s earlier position when its last reply disagrees', async () => {
    const fixtureCase = fixture({ finalBlueDisagrees: true })
    const rounds = await runDebateSession({ roundCount: 2, runRound: fixtureCase.runRound })
    expect(rounds[0]?.convergenceSignal).toBe(false)
    expect(rounds[0]?.threatAssessments[0]?.redVerdict).toBe('high')
    expect(rounds[0]?.threatAssessments[0]?.blueVerdict).toBe('high')
    expect(rounds[1]?.threatAssessments[0]?.blueVerdict).toBe('low')
    expect(rounds[1]?.threatAssessments[0]?.consensus).toBe('disagreed')
    expect(hasDebateConverged(rounds)).toBe(false)
    expect(rounds[1]?.threatAssessments[0]?.judgeNotes).toContain('DRAFT-1')
    expect(rounds[1]?.threatAssessments[0]?.finalVerdict).toBe('medium')
  })

  it('requires Blue to respond substantively rather than repeat its previous turn', async () => {
    const fixtureCase = fixture({ repeatsBlue: true })
    const rounds = await runDebateSession({ roundCount: 2, runRound: fixtureCase.runRound })
    expect(fixtureCase.turns).toEqual(['Red1', 'Blue1', 'Red2', 'Blue2'])
    const finding = rounds[1]!.threatAssessments[0]!
    expect(finding.qualityIssues).toContain('Blue repeated its previous turn instead of responding to Red.')
    expect(isDebateFindingResolved(finding)).toBe(false)
  })

  it('resumes after a persisted pair without replaying it or skipping an agreed candidate', async () => {
    const fixtureCase = fixture()
    const first = await fixtureCase.runRound(1, [], false)
    const rounds = await runDebateSession({ roundCount: 2, previousRounds: [first], runRound: fixtureCase.runRound })
    expect(fixtureCase.turns).toEqual(['Red1', 'Blue1', 'Red2', 'Blue2'])
    expect(rounds[0]).toBe(first)
    expect(rounds[1]?.threatAssessments).toHaveLength(2)
  })

  it('does not start the next pair if its checkpoint fails', async () => {
    const fixtureCase = fixture()
    const onRound = vi.fn().mockRejectedValue(new Error('Checkpoint unavailable'))
    await expect(runDebateSession({ roundCount: 2, runRound: fixtureCase.runRound, onRound })).rejects.toThrow('Checkpoint unavailable')
    expect(fixtureCase.turns).toEqual(['Red1', 'Blue1'])
  })

  it('does not fabricate Blue or a completed pair after a fatal interruption', async () => {
    const fixtureCase = fixture()
    const first = await fixtureCase.runRound(1, [], false)
    const onRound = vi.fn()
    await expect(runDebateSession({ roundCount: 2, previousRounds: [first],
      runRound: async () => { throw new Error('Run cancelled') }, onRound })).rejects.toThrow('Run cancelled')
    expect(onRound).not.toHaveBeenCalled()
  })

  it('distinguishes an adjudicated finding from agreement between the teams', async () => {
    const fixtureCase = fixture({ finalBlueDisagrees: true })
    const rounds = await runDebateSession({ roundCount: 2, runRound: fixtureCase.runRound })
    const disputed = rounds[1]!.threatAssessments[0]!
    const adjudicated = { ...disputed, qualityIssues: [], finalVerdict: 'medium' as const,
      judgeNotes: 'The original source supports a conditional assessment with medium residual impact.' }
    expect(isDebateFindingResolved(adjudicated)).toBe(true)
    expect(hasDebateConverged([{ ...rounds[1]!, convergenceSignal: true, threatAssessments: [adjudicated] }])).toBe(false)
  })
})
