import { describe, expect, it } from 'vitest'
import { formatDebateRoundsMarkdown, formatStoredDebateSummary, parseStoredDebateRounds } from '../debate-format'

const threats = [
  {
    id: 'uuid-1',
    displayId: 'IAM-01',
    title: 'JWT algorithm confusion',
    component: 'API Gateway',
    description: 'An attacker can exploit JWT algorithm confusion at the API gateway.',
    severity: 'high',
  },
  {
    id: 'uuid-2',
    displayId: 'DAT-01',
    title: 'SQL injection',
    component: 'Backend',
    description: 'An attacker can inject SQL through the backend.',
    severity: 'medium',
  },
]

describe('stored debate formatting', () => {
  it('round-trips all three turns without replacing the opening with the reply', () => {
    const markdown = formatDebateRoundsMarkdown([{ round: 1, redTeamArguments: '', blueTeamArguments: '', convergenceSignal: true,
      threatAssessments: [{ draftId: 'DRAFT-1', threatDescription: 'Conditional access scenario', component: 'Gateway',
        redVerdict: 'high', blueVerdict: 'low', redReplyVerdict: 'low', finalVerdict: 'low', disposition: 'mitigated',
        redNotes: 'Opening: a caller might reach a route without the required permission.',
        blueNotes: 'Defense: the documented gateway policy applies a permission check to every route.',
        redReplyNotes: 'Reply: I accept that scope; this scenario requires policy drift rather than normal operation.',
        notes: 'Agreed with the documented policy qualification.' }] }], [])
    const finding = parseStoredDebateRounds(markdown, [])[0]?.findings[0]
    expect(finding?.redNotes).toMatch(/^Opening:/)
    expect(finding?.blueNotes).toMatch(/^Defense:/)
    expect(finding?.blueNotes).not.toContain('Reply:')
    expect(finding?.redReplyNotes).toMatch(/^Reply:/)
    expect(finding?.finalVerdict).toBe('LOW')
  })
  it('flags the legacy copied/blanket-invalidation failure without rewriting the saved responses', () => {
    const rationale = 'The evidence is from another system. The architecture does not specify access controls, so this scenario cannot be validated.'
    const summary = `### Round 1\n\n#### IAM-01 - Access control\n\n**Component:** API Gateway\n\n> **RED TEAM · INVALID**\n> ${rationale}\n\n> **BLUE TEAM · INVALID**\n> ${rationale}\n\n**Final disposition: CONTROL VERIFICATION NEEDED (MEDIUM)**\nSafeguard: blanket invalidation was treated as an inconsistent model response.\n\n**Round status:** Converged`
    const finding = parseStoredDebateRounds(summary, threats)[0]?.findings[0]
    expect(finding).toMatchObject({ finalVerdict: 'unresolved', recordedFinalVerdict: 'MEDIUM', redNotes: rationale, blueNotes: rationale })
    expect(finding?.qualityIssues).toHaveLength(2)
  })
  it('parses the structured per-finding debate persisted by the pipeline', () => {
    const summary = `### Round 1

#### IAM-01 - JWT algorithm confusion

**Component:** API Gateway

> **RED TEAM · HIGH**
> The gateway accepts an unsafe algorithm fallback.

> **BLUE TEAM · MEDIUM**
> Enforce an explicit allow-list and bind the issuer.

> **RED REPLY · MEDIUM**
> I accept the issuer constraint; verify whether it covers every route.

**Final disposition: APPLICABLE (HIGH)**  
Configuration evidence is still required.

#### Independent adjudication

Keep the finding open until the gateway policy is verified.

**Round status:** Converged`

    const [round] = parseStoredDebateRounds(summary, threats)

    expect(round?.findings).toHaveLength(1)
    expect(round?.findings[0]).toMatchObject({
      id: 'IAM-01',
      redVerdict: 'HIGH',
      blueVerdict: 'MEDIUM',
      finalVerdict: 'HIGH',
      disposition: 'APPLICABLE',
      redNotes: 'The gateway accepts an unsafe algorithm fallback.',
      blueNotes: 'Enforce an explicit allow-list and bind the issuer.',
      redReplyNotes: 'I accept the issuer constraint; verify whether it covers every route.',
      redReplyVerdict: 'MEDIUM',
      judgeNotes: 'Configuration evidence is still required.',
    })
    expect(round?.judge).toBe('Keep the finding open until the gateway policy is verified.')
  })

  it('does not invent a process-status conclusion for open or agreed findings', () => {
    const markdown = formatDebateRoundsMarkdown([
      {
        round: 1, isFinalRound: false, redTeamArguments: '', blueTeamArguments: '', convergenceSignal: false,
        threatAssessments: [{
          draftId: 'DRAFT-1', threatDescription: 'JWT algorithm confusion', component: 'API Gateway',
          redVerdict: 'high', blueVerdict: 'high', finalVerdict: 'high', disposition: 'control_verification_needed',
          consensus: 'agreed', notes: 'Red: route coverage. | Blue: plugin list.',
          redNotes: 'Unsigned tokens remain possible on this route.',
          blueNotes: 'JWT validation is documented; verify this route is covered.',
        }],
      },
      {
        round: 2, isFinalRound: true, redTeamArguments: '', blueTeamArguments: '', convergenceSignal: true,
        threatAssessments: [{
          draftId: 'DRAFT-1', threatDescription: 'JWT algorithm confusion', component: 'API Gateway',
          redVerdict: 'high', blueVerdict: 'high', finalVerdict: 'high', disposition: 'control_verification_needed',
          consensus: 'agreed', notes: 'Conclusion: verify plugin coverage. | Red: remaining route. | Blue: plugin list.',
          redNotes: 'I accept the documented plugin; remaining risk is this route.',
          blueNotes: 'Confirm the users route is in the JWT plugin list.',
          judgeNotes: 'High residual remains until the users route is confirmed in the JWT plugin list.',
        }],
      },
    ], threats)
    expect(markdown).not.toContain('The dialogue continues in the next configured round.')
    expect(markdown).not.toContain('Both teams reached the same applicability')
    const parsed = parseStoredDebateRounds(markdown, threats)
    expect(parsed[0]?.findings[0]?.provisional).toBe(true)
    expect(parsed[0]?.findings[0]?.judgeNotes).toBe('')
    expect(parsed[1]?.findings[0]?.judgeNotes).toContain('users route is confirmed')
  })

  it('trusts persisted debate quality markers instead of reclassifying formatted prose', () => {
    const shared = 'The architecture documents the gateway route and its authorization boundary. The remaining question is whether the policy covers this operation and every downstream resource before access is granted.'
    const markdown = formatDebateRoundsMarkdown([{
      round: 1, isFinalRound: true, redTeamArguments: '', blueTeamArguments: '', convergenceSignal: true,
      threatAssessments: [{
        draftId: 'DRAFT-1', threatDescription: 'Authorization coverage', component: 'API Gateway',
        redVerdict: 'high', blueVerdict: 'high', finalVerdict: 'high', disposition: 'control_verification_needed',
        consensus: 'agreed', qualityIssues: [], notes: 'Conclusion: verify route coverage.',
        redNotes: `${shared} Red retains the finding until that implementation evidence is supplied.`,
        blueNotes: `${shared} Blue requires the route-to-policy mapping before treating the control as complete.`,
        judgeNotes: 'The residual finding remains high until policy coverage for this route is verified.',
      }],
    }], threats)

    const finding = parseStoredDebateRounds(markdown, threats)[0]?.findings[0]
    expect(finding?.consensus).toBe('Agreed')
    expect(finding?.qualityIssues).toBeUndefined()
    expect(finding?.finalVerdict).toBe('HIGH')
  })

  it('preserves an explicitly persisted review issue', () => {
    const markdown = formatDebateRoundsMarkdown([{
      round: 1, isFinalRound: true, redTeamArguments: '', blueTeamArguments: '', convergenceSignal: false,
      threatAssessments: [{
        draftId: 'DRAFT-1', threatDescription: 'Authorization coverage', component: 'API Gateway',
        redVerdict: 'high', blueVerdict: 'high', finalVerdict: 'unresolved', disposition: 'control_verification_needed',
        consensus: 'unverified', qualityIssues: ['Independent review could not be verified.'], notes: 'Review required.',
        redNotes: 'The same route may be uncovered.', blueNotes: 'The same route may be uncovered.',
      }],
    }], threats)

    expect(parseStoredDebateRounds(markdown, threats)[0]?.findings[0]?.qualityIssues)
      .toEqual(['Independent review could not be verified.'])
  })

  it('renders provisional narration as an interim conclusion instead of a judge ruling', () => {
    const markdown = formatDebateRoundsMarkdown([{
      round: 1, isFinalRound: false, redTeamArguments: '', blueTeamArguments: '', convergenceSignal: false,
      threatAssessments: [{
        draftId: 'DRAFT-1', threatDescription: 'Authorization coverage', component: 'API Gateway',
        redVerdict: 'high', blueVerdict: 'medium', finalVerdict: 'unresolved', disposition: 'control_verification_needed',
        consensus: 'disagreed', qualityIssues: [], notes: 'The route policy remains disputed.',
        redNotes: 'The route may lack record authorization.',
        blueNotes: 'Gateway identity validation is documented, but downstream scope is unknown.',
        interimSummary: 'Both sides accept the gateway boundary; the next round must settle downstream policy coverage.',
      }],
    }], threats)

    expect(markdown).toContain('Interim conclusion: Both sides accept the gateway boundary')
    expect(markdown).not.toContain('Independent adjudication')
  })

  it('never prints two findings under the same display ID', () => {
    // v27 regression: eight debate assessments were matched against nine final
    // threats by independent best-score, so two findings printed as AI-08 and
    // two as AI-04 while three threats never appeared. The display ID is the
    // join key for the quality evaluation, so a collision drops findings.
    const shared = (draftId: string, component: string) => ({
      draftId, component, threatDescription: 'Prompt injection reaches the orchestrator agent',
      redVerdict: 'medium' as const, blueVerdict: 'medium' as const, finalVerdict: 'medium' as const,
      disposition: 'conditional' as const, consensus: 'agreed' as const, notes: 'n',
      redNotes: 'Orchestrator delegates on interpreted natural language.',
      blueNotes: 'Least privilege governs the stores, not prompt interpretation.',
      judgeNotes: 'Residual medium until input filtering at the chat boundary is confirmed.',
    })
    const markdown = formatDebateRoundsMarkdown([{
      round: 1, isFinalRound: true, redTeamArguments: '', blueTeamArguments: '', convergenceSignal: true,
      threatAssessments: [shared('DRAFT-1', 'API Gateway'), shared('DRAFT-2', 'Backend')],
    }], threats)
    const ids = markdown.match(/^#### (\S+) - /gm) ?? []
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('does not fabricate one missing-rationale card for every final threat in legacy summaries', () => {
    const summary = `### Round 1

**Red Team:**

**DRAFT-1 Assessment:** JWT algorithm confusion is plausible at the gateway.

**Overall Conclusion:** Validate the gateway configuration.

**Blue Team:** The issue is mitigated only when an explicit algorithm allow-list is enforced.

**Judge:** Preserve the finding pending configuration evidence.

**Assessments:**
- JWT algorithm confusion at the gateway -> high (red=high, blue=medium)`

    const [round] = parseStoredDebateRounds(summary, threats)
    const report = formatStoredDebateSummary(summary, threats)

    expect(round?.findings).toHaveLength(1)
    expect(round?.findings[0]?.redNotes).toContain('JWT algorithm confusion is plausible')
    expect(report).toContain('Red Team round position')
    expect(report).not.toContain('No separate offensive rationale was persisted')
    expect(report.match(/^#### IAM-/gm)).toHaveLength(1)
  })
})
