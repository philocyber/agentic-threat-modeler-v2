import { describe, expect, it } from 'vitest'
import {
  buildStage2Fixture,
  evaluateStage2Run,
} from '../stage2-acceptance'
import type { DebateRound } from '@/lib/models/types'

function round(
  number: number,
  isFinalRound: boolean,
  notes: Record<string, { red: string; blue: string; verdict?: DebateRound['threatAssessments'][number]['finalVerdict']; disposition?: DebateRound['threatAssessments'][number]['disposition']; conclusion?: string }>,
): DebateRound {
  return {
    round: number,
    isFinalRound,
    redTeamArguments: '',
    blueTeamArguments: '',
    convergenceSignal: false,
    threatAssessments: Object.entries(notes).map(([draftId, item]) => ({
      draftId,
      threatDescription: draftId,
      redVerdict: item.verdict === 'invalid' ? 'invalid' : 'medium',
      blueVerdict: item.verdict === 'invalid' ? 'invalid' : 'medium',
      finalVerdict: item.verdict ?? 'medium',
      disposition: item.disposition ?? (item.verdict === 'invalid' ? 'invalid' : 'conditional'),
      notes: `${item.red} ${item.blue}`,
      redNotes: item.red,
      blueNotes: item.blue,
      ...(isFinalRound ? { judgeNotes: item.conclusion ?? `${draftId}: ${item.blue}` } : {}),
    })),
  }
}

function passingRun() {
  const fixture = buildStage2Fixture()
  const sectionId = (heading: string) => fixture.architecture.sourceEvidence!.sections
    .find((section) => section.heading === heading)!.id
  const gateway = sectionId('ReviewGateway')
  const transport = sectionId('Transport')
  const desk = sectionId('ReviewDesk')
  const scope = sectionId('Scope')
  const historical = sectionId('Control register (historical)')
  const current = sectionId('Control register (current operations)')
  const rounds: DebateRound[] = [
    round(1, false, {
      'DRAFT-1': { red: `Unsigned JWT tokens at ReviewGateway because validation is disabled ${gateway}.`, blue: 'That JWT control is disabled; residual replay remains.' },
      'DRAFT-2': { red: `Origin path uses TLS 1.2 re-encryption ${transport}.`, blue: 'Plaintext is not used on the origin path; residual risk is configuration drift.' },
      'DRAFT-3': { red: `REPORTING grants are unknown and not documented ${desk}.`, blue: 'This needs verification, not a proven missing control.' },
      'DRAFT-4': { red: `ReviewDesk has no payment service ${scope}.`, blue: 'Payment is out of scope.', verdict: 'invalid', disposition: 'invalid' },
      'DRAFT-5': { red: 'The System B ePHI ledger does not prove a ReviewDesk weakness.', blue: 'Foreign RAG is unrelated to this system.' },
      'DRAFT-6': { red: `Historical register says JWT enabled ${historical} but current operations says disabled ${current}; that is a contradiction.`, blue: 'Reconcile the conflict before treating enablement as fact.' },
    }),
    round(2, true, {
      'DRAFT-1': { red: 'Blue accepts the disabled JWT control; unsigned tokens remain in scope.', blue: 'Agreed: ReviewGateway accepts unsigned tokens.' },
      'DRAFT-2': { red: 'I accept the documented origin TLS control.', blue: 'Mitigated for the origin path as written.' },
      'DRAFT-3': { red: 'Unknown grants still need verification.', blue: 'Do not convert unknown into absent.' },
      'DRAFT-4': { red: 'Still no payment endpoint in this architecture.', blue: 'Invalid: out of scope.', verdict: 'invalid', disposition: 'invalid' },
      'DRAFT-5': { red: 'I do not use System B as proof for ReviewDesk.', blue: 'Unrelated RAG stays unlinked.' },
      'DRAFT-6': { red: 'Both enabled and disabled statements remain; this is inconsistent.', blue: 'Control verification until operations reconciles the register.' },
    }),
  ]
  return { ...fixture, rounds }
}

function evaluateFixture(rounds: DebateRound[]) {
  const fixture = passingRun()
  return evaluateStage2Run({
    source: fixture.architecture.sourceEvidence!,
    foreignPassage: fixture.foreignPassage,
    cases: fixture.cases,
    rounds,
  })
}

describe('stage 2 acceptance evaluator', () => {
  it('passes complete notes that follow the source and fails invented facts', () => {
    const { architecture, cases, foreignPassage } = buildStage2Fixture()
    const gateway = architecture.sourceEvidence!.sections.find((section) => section.heading === 'ReviewGateway')!.id
    const transport = architecture.sourceEvidence!.sections.find((section) => section.heading === 'Transport')!.id
    const desk = architecture.sourceEvidence!.sections.find((section) => section.heading === 'ReviewDesk')!.id
    const scope = architecture.sourceEvidence!.sections.find((section) => section.heading === 'Scope')!.id
    const historical = architecture.sourceEvidence!.sections.find((section) => section.heading === 'Control register (historical)')!.id
    const current = architecture.sourceEvidence!.sections.find((section) => section.heading === 'Control register (current operations)')!.id

    const goodRounds = [
        round(1, false, {
          'DRAFT-1': { red: `Unsigned JWT tokens at ReviewGateway because validation is disabled ${gateway}.`, blue: 'That JWT control is disabled; residual replay remains.' },
          'DRAFT-2': { red: `Origin path uses TLS 1.2 re-encryption ${transport}.`, blue: 'Plaintext is not used on the origin path; residual risk is configuration drift.' },
          'DRAFT-3': { red: `REPORTING grants are unknown and not documented ${desk}.`, blue: 'This needs verification, not a proven missing control.' },
          'DRAFT-4': { red: `ReviewDesk has no payment service ${scope}.`, blue: 'Payment is out of scope.', verdict: 'invalid', disposition: 'invalid' },
          'DRAFT-5': { red: 'The System B ePHI ledger does not prove a ReviewDesk weakness.', blue: 'Foreign RAG is unrelated to this system.' },
          'DRAFT-6': { red: `Historical register says JWT enabled ${historical} but current operations says disabled ${current}; that is a contradiction.`, blue: 'Reconcile the conflict before treating enablement as fact.' },
        }),
        round(2, true, {
          'DRAFT-1': { red: 'Blue accepts the disabled JWT control; unsigned tokens remain in scope.', blue: 'Agreed: ReviewGateway accepts unsigned tokens.' },
          'DRAFT-2': { red: 'I accept the documented origin TLS control.', blue: 'Mitigated for the origin path as written.' },
          'DRAFT-3': { red: 'Unknown grants still need verification.', blue: 'Do not convert unknown into absent.' },
          'DRAFT-4': { red: 'Still no payment endpoint in this architecture.', blue: 'Invalid: out of scope.', verdict: 'invalid', disposition: 'invalid' },
          'DRAFT-5': { red: 'I do not use System B as proof for ReviewDesk.', blue: 'Unrelated RAG stays unlinked.' },
          'DRAFT-6': { red: 'Both enabled and disabled statements remain; this is inconsistent.', blue: 'Control verification until operations reconciles the register.' },
        }),
      ]
    const good = evaluateStage2Run({
      source: architecture.sourceEvidence!,
      foreignPassage,
      cases,
      rounds: goodRounds,
    })
    expect(good.passed).toBe(true)
    expect(good.cases.every((item) => item.interventions === 4)).toBe(true)

    const invented = evaluateStage2Run({
      source: architecture.sourceEvidence!,
      foreignPassage,
      cases,
      rounds: good.rounds === 2 ? [
        round(1, false, {
          'DRAFT-1': { red: 'ReviewDesk payment endpoint allows card data theft and ePHI disclosure.', blue: 'Critical payment breach.' },
          'DRAFT-2': { red: 'No TLS exists.', blue: 'Plaintext origin is proven.' },
          'DRAFT-3': { red: 'Grants are absent.', blue: 'No authorization exists.' },
          'DRAFT-4': { red: 'The payment endpoint allows unauthorized payment succeeds.', blue: 'Charge the card.', verdict: 'high', disposition: 'applicable' },
          'DRAFT-5': { red: 'ReviewDesk stores ePHI like System B.', blue: 'This system stores ePHI.' },
          'DRAFT-6': { red: 'The historical register proves jwt is enabled in production without conflict.', blue: 'No issue.' },
        }),
        round(2, true, {
          'DRAFT-1': { red: 'ePHI again.', blue: 'Card data.' },
          'DRAFT-2': { red: 'No TLS.', blue: 'Plaintext origin is proven.' },
          'DRAFT-3': { red: 'Grants are absent.', blue: 'No authorization exists.' },
          'DRAFT-4': { red: 'Payment endpoint allows.', blue: 'Unauthorized payment succeeds.', verdict: 'high', disposition: 'applicable' },
          'DRAFT-5': { red: 'ReviewDesk stores ePHI.', blue: 'This system stores ePHI.' },
          'DRAFT-6': { red: 'The historical register proves jwt is enabled in production without conflict.', blue: 'Enabled only.' },
        }),
      ] : [],
    })
    expect(invented.passed).toBe(false)
    expect(invented.cases.filter((item) => !item.passed).map((item) => item.kind)).toEqual([
      'supported_risk', 'mitigating_control', 'unknown_control', 'absent_component', 'foreign_rag', 'contradiction',
    ])

    const quotedRejection = evaluateStage2Run({
      source: architecture.sourceEvidence!,
      foreignPassage,
      cases,
      rounds: [
        round(1, false, {
          'DRAFT-1': { red: `Unsigned JWT tokens at ReviewGateway because validation is disabled ${gateway}.`, blue: 'That JWT control is disabled; residual replay remains.' },
          'DRAFT-2': { red: `Origin path uses TLS 1.2 re-encryption ${transport}.`, blue: 'Plaintext is not used on the origin path; residual risk is configuration drift.' },
          'DRAFT-3': { red: `REPORTING grants are unknown and not documented ${desk}.`, blue: 'This needs verification, not a proven missing control.' },
          'DRAFT-4': { red: `ReviewDesk has no payment service ${scope}.`, blue: 'Payment is out of scope.', verdict: 'invalid', disposition: 'invalid' },
          'DRAFT-5': { red: 'The claim that ReviewDesk stores ePHI does not prove a weakness in this system.', blue: 'System B is unrelated; this system does not store ePHI.' },
          'DRAFT-6': { red: `Historical register says JWT enabled ${historical} but current operations says disabled ${current}; that is a contradiction.`, blue: 'Reconcile the conflict before treating enablement as fact.' },
        }),
        round(2, true, {
          'DRAFT-1': { red: 'Blue accepts the disabled JWT control; unsigned tokens remain in scope.', blue: 'Agreed: ReviewGateway accepts unsigned tokens.' },
          'DRAFT-2': { red: 'I accept the documented origin TLS control.', blue: 'Mitigated for the origin path as written.' },
          'DRAFT-3': { red: 'Unknown grants still need verification.', blue: 'Do not convert unknown into absent.' },
          'DRAFT-4': { red: 'Still no payment endpoint in this architecture.', blue: 'Invalid: out of scope.', verdict: 'invalid', disposition: 'invalid' },
          'DRAFT-5': { red: 'I do not use System B as proof for ReviewDesk.', blue: 'Unrelated RAG stays unlinked.' },
          'DRAFT-6': { red: 'Both enabled and disabled statements remain; this is inconsistent.', blue: 'Control verification until operations reconciles the register.' },
        }),
      ],
    })
    expect(quotedRejection.cases.find((item) => item.kind === 'foreign_rag')?.passed).toBe(true)
    expect(quotedRejection.passed).toBe(true)
  })

  it('rejects an empty candidate set even when both rounds are structurally empty', () => {
    const fixture = buildStage2Fixture()
    const result = evaluateStage2Run({
      source: fixture.architecture.sourceEvidence!,
      foreignPassage: fixture.foreignPassage,
      cases: [],
      rounds: [round(1, false, {}), round(2, true, {})],
    })
    expect(result.passed).toBe(false)
    expect(result.issues).toContain('Stage 2 requires at least one candidate.')
  })

  it('rejects a candidate omitted from one configured round', () => {
    const fixture = passingRun()
    fixture.rounds[1]!.threatAssessments = fixture.rounds[1]!.threatAssessments
      .filter((item) => item.draftId !== 'DRAFT-1')
    const result = evaluateFixture(fixture.rounds)
    expect(result.passed).toBe(false)
    expect(result.cases.find((item) => item.draftId === 'DRAFT-1')?.issues)
      .toEqual(expect.arrayContaining([expect.stringContaining('Round 2 is missing its assessment')]))
  })

  it('rejects duplicate candidate assessments in a round', () => {
    const fixture = passingRun()
    fixture.rounds[0]!.threatAssessments.push({ ...fixture.rounds[0]!.threatAssessments[0]! })
    const result = evaluateFixture(fixture.rounds)
    expect(result.passed).toBe(false)
    expect(result.cases.find((item) => item.draftId === 'DRAFT-1')?.issues)
      .toEqual(expect.arrayContaining([expect.stringContaining('duplicate assessments')]))
  })

  it('rejects nonchronological round identifiers', () => {
    const fixture = passingRun()
    fixture.rounds[1]!.round = 1
    const result = evaluateFixture(fixture.rounds)
    expect(result.passed).toBe(false)
    expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining('chronological round 2')]))
  })

  it('rejects judge output before the final Blue turn', () => {
    const fixture = passingRun()
    fixture.rounds[0]!.threatAssessments[0]!.judgeNotes = 'Premature ruling before the final Blue turn.'
    const result = evaluateFixture(fixture.rounds)
    expect(result.passed).toBe(false)
    expect(result.cases.find((item) => item.draftId === 'DRAFT-1')?.issues)
      .toEqual(expect.arrayContaining([expect.stringContaining('judge must wait')]))
  })

  it('rejects a final round that only records process status instead of a finding conclusion', () => {
    const fixture = passingRun()
    fixture.rounds[1]!.threatAssessments[0]!.judgeNotes = 'Both teams reached the same applicability and severity assessment. Their reasoning is preserved above.'
    const result = evaluateFixture(fixture.rounds)
    expect(result.passed).toBe(false)
    expect(result.cases.find((item) => item.draftId === 'DRAFT-1')?.issues)
      .toEqual(expect.arrayContaining([expect.stringContaining('finding-specific conclusion')]))
  })

  it('rejects a quality issue reported in an earlier round', () => {
    const fixture = passingRun()
    fixture.rounds[0]!.threatAssessments[0]!.qualityIssues = ['Opening-round quality failure.']
    const result = evaluateFixture(fixture.rounds)
    expect(result.passed).toBe(false)
    expect(result.cases.find((item) => item.draftId === 'DRAFT-1')?.issues)
      .toEqual(expect.arrayContaining([expect.stringContaining('Opening-round quality failure')]))
  })

  it('rejects a missing final verdict field', () => {
    const fixture = passingRun()
    const assessment = fixture.rounds[1]!.threatAssessments[0] as unknown as Record<string, unknown>
    assessment.finalVerdict = undefined
    const result = evaluateFixture(fixture.rounds)
    expect(result.passed).toBe(false)
    expect(result.cases.find((item) => item.draftId === 'DRAFT-1')?.issues)
      .toEqual(expect.arrayContaining([expect.stringContaining('invalid finalVerdict')]))
  })

  it('does not count judge notes in place of a Blue intervention', () => {
    const fixture = passingRun()
    fixture.rounds[1]!.threatAssessments[0]!.blueNotes = undefined
    fixture.rounds[1]!.threatAssessments[0]!.judgeNotes = 'Final ruling recorded after Blue.'
    const result = evaluateFixture(fixture.rounds)
    expect(result.passed).toBe(false)
    expect(result.cases.find((item) => item.draftId === 'DRAFT-1')?.interventions).toBe(3)
  })

  it('rejects an unavailable side verdict even when the notes are complete', () => {
    const fixture = passingRun()
    fixture.rounds[1]!.threatAssessments[0]!.redVerdict = 'unavailable'
    const result = evaluateFixture(fixture.rounds)
    expect(result.passed).toBe(false)
    expect(result.cases.find((item) => item.draftId === 'DRAFT-1')?.issues)
      .toEqual(expect.arrayContaining([expect.stringContaining('unavailable or unresolved side verdict')]))
  })

  it('rejects an unresolved side verdict even when the notes are complete', () => {
    const fixture = passingRun()
    fixture.rounds[1]!.threatAssessments[0]!.blueVerdict = 'unresolved'
    const result = evaluateFixture(fixture.rounds)
    expect(result.passed).toBe(false)
    expect(result.cases.find((item) => item.draftId === 'DRAFT-1')?.issues)
      .toEqual(expect.arrayContaining([expect.stringContaining('unavailable or unresolved side verdict')]))
  })

  it('rejects an unexpected candidate ID in a round', () => {
    const fixture = passingRun()
    fixture.rounds[0]!.threatAssessments.push({
      ...fixture.rounds[0]!.threatAssessments[0]!,
      draftId: 'DRAFT-UNEXPECTED',
    })
    const result = evaluateFixture(fixture.rounds)
    expect(result.passed).toBe(false)
    expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining('unexpected candidate DRAFT-UNEXPECTED')]))
  })

  it('rejects malformed round metadata and missing assessment arrays', () => {
    const fixture = passingRun()
    const malformedRound = fixture.rounds[1] as unknown as Record<string, unknown>
    malformedRound.isFinalRound = undefined
    malformedRound.threatAssessments = undefined
    const result = evaluateFixture(fixture.rounds)
    expect(result.passed).toBe(false)
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('Round 2 is missing isFinalRound'),
      expect.stringContaining('Round 2 is missing threat assessments'),
    ]))
  })

  it('rejects identical Red and Blue notes within a round', () => {
    const fixture = passingRun()
    const assessment = fixture.rounds[1]!.threatAssessments[0]!
    assessment.blueNotes = assessment.redNotes
    const result = evaluateFixture(fixture.rounds)
    expect(result.passed).toBe(false)
    expect(result.cases.find((item) => item.draftId === 'DRAFT-1')?.issues)
      .toContain('Red and Blue returned identical notes for a round.')
  })

  it('rejects identical Red notes across rounds', () => {
    const fixture = passingRun()
    fixture.rounds[1]!.threatAssessments[0]!.redNotes = fixture.rounds[0]!.threatAssessments[0]!.redNotes
    const result = evaluateFixture(fixture.rounds)
    expect(result.passed).toBe(false)
    expect(result.cases.find((item) => item.draftId === 'DRAFT-1')?.issues)
      .toContain('Red returned identical notes in both rounds.')
  })

  it('rejects identical Blue notes across rounds', () => {
    const fixture = passingRun()
    fixture.rounds[1]!.threatAssessments[0]!.blueNotes = fixture.rounds[0]!.threatAssessments[0]!.blueNotes
    const result = evaluateFixture(fixture.rounds)
    expect(result.passed).toBe(false)
    expect(result.cases.find((item) => item.draftId === 'DRAFT-1')?.issues)
      .toContain('Blue returned identical notes in both rounds.')
  })
})
