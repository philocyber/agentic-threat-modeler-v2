import { duplicatedDebateRationale, repeatedOwnTurn } from './debate-quality'

export type NamedNotes = { draftId: string; notes: string }

export type InvalidDebateTurns = {
  ids: string[]
  copiedOpponent: boolean
  repeatedOwn: boolean
}

function notesById(items: NamedNotes[] | undefined): Map<string, string> {
  return new Map((items ?? []).map((item) => [item.draftId, item.notes]))
}

/** A reply that copies the opponent or restates the same team's previous turn is not independent review. */
export function classifyInvalidDebateTurns(params: {
  current: NamedNotes[]
  opponent?: NamedNotes[]
  previousOwn?: NamedNotes[]
  copyContainment?: number
}): InvalidDebateTurns {
  const opponent = notesById(params.opponent)
  const previousOwn = notesById(params.previousOwn)
  const copied: string[] = []
  const repeated: string[] = []
  for (const item of params.current) {
    if (duplicatedDebateRationale(opponent.get(item.draftId), item.notes, params.copyContainment)) copied.push(item.draftId)
    if (repeatedOwnTurn(item.notes, previousOwn.get(item.draftId), params.copyContainment)) repeated.push(item.draftId)
  }
  return {
    ids: [...new Set([...copied, ...repeated])],
    copiedOpponent: copied.length > 0,
    repeatedOwn: repeated.length > 0,
  }
}

export function debateTurnRepairTask(ids: string[], invalid: InvalidDebateTurns): string {
  const reasons = [
    invalid.copiedOpponent
      ? "The prior response duplicated the opponent's rationale and cannot establish independent review."
      : '',
    invalid.repeatedOwn
      ? 'The prior response repeated your previous turn instead of answering the latest opposing argument.'
      : '',
  ].filter(Boolean)
  return `Invalid debate turn repair ONLY for ${ids.join(', ')}. ${reasons.join(' ')} Re-evaluate from the original source and your own notes. Name the opponent's premise, then accept, challenge, or state remaining uncertainty. Keep any supported verdict, including invalid; do not invent disagreement or copy earlier prose.`
}

/** Hide copied opponent prose so a repair cannot pass by paraphrasing it. Show it when the failure was self-repetition. */
export function includeOpponentInRepair(invalid: InvalidDebateTurns): boolean {
  return invalid.repeatedOwn && !invalid.copiedOpponent
}

export function formatNotesForRepair(items: NamedNotes[]): string {
  return items.map((item) => `${item.draftId}: ${item.notes}`).join('\n')
}
