import { describe, expect, it } from 'vitest'
import { duplicatedDebateRationale, repeatedOwnTurn, writtenFindingConclusion } from '../debate-quality'
import { mergeAssessments } from '../debate'
import type { DebateCandidate } from '@/lib/models/types'

const candidate: DebateCandidate = {
  draftId: 'DRAFT-1',
  component: 'API',
  methodology: 'STRIDE',
  description: 'Token forgery at the gateway',
  impact: 'Access',
  mitigation: 'Validate signatures',
  confidenceScore: 0.8,
  evidenceSources: [],
}

function side(notes: string, verdict: 'high' | 'medium' | 'invalid' = 'high') {
  return {
    arguments: notes,
    convergenceSignal: false,
    threatAssessments: [{
      draftId: 'DRAFT-1',
      threatDescription: candidate.description,
      notes,
      verdict,
      disposition: verdict === 'invalid' ? 'invalid' as const : 'applicable' as const,
    }],
  }
}

describe('debate copy and self-repetition', () => {
  it('does not treat process-status copy as a finding conclusion', () => {
    expect(writtenFindingConclusion('Both teams reached the same applicability and severity assessment. Their reasoning is preserved above.')).toBeUndefined()
    expect(writtenFindingConclusion('The dialogue continues in the next configured round.')).toBeUndefined()
    expect(writtenFindingConclusion('Unsigned tokens remain a high residual until plugin coverage is verified.')).toBe('Unsigned tokens remain a high residual until plugin coverage is verified.')
  })
  it('does not treat shared catalog citations as copied arguments', () => {
    const red = 'The SRC-0001 control limits blast radius if JWT validation stays enabled. Residual risk is replay.'
    const blue = 'SRC-0001 documents JWT validation. That control does not prove replay protection exists.'
    expect(duplicatedDebateRationale(red, blue)).toBe(false)
  })

  it('flags a team that repeats its previous turn instead of answering', () => {
    const notes = 'The gateway still accepts unsigned tokens when the plugin is disabled in staging.'
    expect(repeatedOwnTurn(notes, notes)).toBe(true)
    const merged = mergeAssessments(
      [candidate],
      side(notes),
      side('JWT validation is enabled in production and staging uses a separate audience.', 'medium'),
      undefined,
      true,
      [{
        draftId: 'DRAFT-1',
        threatDescription: candidate.description,
        redVerdict: 'high',
        blueVerdict: 'medium',
        finalVerdict: 'unresolved',
        notes,
        redNotes: notes,
        blueNotes: 'Earlier blue notes about the plugin.',
      }],
    )
    expect(merged[0]?.qualityIssues?.some((issue) => issue.includes('repeated'))).toBe(true)
    expect(merged[0]?.consensus).toBe('unverified')
  })
})

describe('copy detection strictness', () => {
  // Measured against the v27 Ollama transcript: in round 2 Blue restated Red's
  // paragraph and padded it with one sentence of its own. The symmetric 0.85
  // Dice threshold scored those pairs 0.58-0.83 and let every one through, so
  // the repair loop never fired and copied prose was recorded as consensus.
  const redTurn = 'The architecture states the Procurement Agent routes POs based on a threshold (SRC-0001). CTRL-03 confirms this rule but does not guarantee immutability. If an attacker can manipulate the input data used to calculate the threshold, they can bypass the human gate without compromising the logic code itself. The scenario remains plausible due to the lack of documented input validation.'
  const blueEcho = 'Red is correct on this point. The architecture states the Procurement Agent routes POs based on a threshold (SRC-0001). CTRL-03 confirms this rule but does not guarantee immutability. If an attacker can manipulate the input data used to calculate the threshold, they can bypass the human gate without compromising the logic code itself. The scenario remains plausible due to the lack of documented input validation.'
  const blueIndependent = 'CTRL-03 is documented as an enabled routing rule, and the ledger records no audit logging on the boundary check. What the source does not settle is whether the threshold is a hard-coded constant or a database field, so the verification question is where that value is stored and who can write to it.'

  it('flags a turn that restates the opponent behind a short preamble', () => {
    expect(duplicatedDebateRationale(redTurn, blueEcho)).toBe(true)
  })

  it('does not flag an independent control analysis that cites the same facts', () => {
    expect(duplicatedDebateRationale(redTurn, blueIndependent)).toBe(false)
  })

  it('leaves short turns alone, where shared phrasing is coincidence', () => {
    expect(duplicatedDebateRationale(
      'CTRL-03 routes purchase orders above the threshold to a human approver.',
      'CTRL-03 routes purchase orders above the threshold, but immutability is unproven.',
    )).toBe(false)
  })
})
