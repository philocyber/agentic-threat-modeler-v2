import type { DebateRound } from '@/lib/models/types'

/** Execute the configured number of balanced pairs, including after agreement.
 * Checkpoint each pair before starting the next. Model signals never shorten
 * the dialogue; cancellation or execution failures still propagate normally.
 */
export async function runDebateSession(params: {
  roundCount: number
  previousRounds?: DebateRound[]
  runRound: (round: number, previous: DebateRound[], isFinalRound: boolean) => Promise<DebateRound>
  onRound?: (rounds: DebateRound[]) => Promise<void>
}): Promise<DebateRound[]> {
  if (!Number.isInteger(params.roundCount) || params.roundCount < 1) {
    throw new Error('Debate rounds must be a positive integer.')
  }
  const rounds = [...(params.previousRounds ?? [])]
  if (rounds.length > params.roundCount || rounds.some((round, i) => round.round !== i + 1)) {
    throw new Error('The debate checkpoint is not a contiguous prefix of the configured rounds.')
  }
  for (let number = rounds.length + 1; number <= params.roundCount; number++) {
    const round = await params.runRound(number, rounds.slice(), number === params.roundCount)
    if (round.round !== number) throw new Error('The debate returned an unexpected round number.')
    rounds.push(round)
    await params.onRound?.(rounds.slice())
  }
  return rounds
}
