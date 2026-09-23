import type { DebateRound } from '@/lib/models/types'
import { buildThreatDisplayIdMap } from '@/lib/models/threat-display-id'
import { debateAssessmentIssues, writtenFindingConclusion } from './debate-quality'

type ReportThreat = {
  id: string
  displayId?: string | undefined
  title?: string | null | undefined
  component?: string | null | undefined
  description: string
  priority?: string | undefined
  severity?: string | null | undefined
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 3))
}

function overlapScore(assessment: DebateRound['threatAssessments'][number], threat: ReportThreat): number {
  const source = tokens(`${assessment.component ?? ''} ${assessment.threatDescription}`)
  const target = tokens(`${threat.component ?? ''} ${threat.title ?? ''} ${threat.description}`)
  return [...source].filter((token) => target.has(token)).length
}

/**
 * Assign one threat per assessment.
 *
 * Scoring each assessment independently let the best-matching threat win every
 * time, so several findings in a round printed under the same display ID while
 * other threats never appeared: one transcript showed eight findings under six
 * IDs. Downstream code keys the debate by that ID (threat-quality.ts), so a
 * collision silently drops findings. Assignments are made in descending score
 * order and a threat is consumed once taken, which keeps the mapping one-to-one. Debate candidates are a subset of the final threats, so
 * leftover assessments legitimately have no threat and fall back to position.
 */
function matchThreats(
  assessments: DebateRound['threatAssessments'],
  threats: ReportThreat[],
): Array<ReportThreat | undefined> {
  const pairs = assessments.flatMap((assessment, index) =>
    threats.map((threat, threatIndex) => ({ index, threatIndex, score: overlapScore(assessment, threat) })))
    .filter((pair) => pair.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
  const assigned = new Array<ReportThreat | undefined>(assessments.length).fill(undefined)
  const takenThreats = new Set<number>()
  const takenAssessments = new Set<number>()
  for (const pair of pairs) {
    if (takenAssessments.has(pair.index) || takenThreats.has(pair.threatIndex)) continue
    assigned[pair.index] = threats[pair.threatIndex]
    takenAssessments.add(pair.index)
    takenThreats.add(pair.threatIndex)
  }
  return assigned.map((threat, index) => {
    if (threat) return threat
    const fallback = threats[index]
    return fallback && !takenThreats.has(index) ? fallback : undefined
  })
}

function quote(value: string): string {
  return value.trim().split('\n').map((line) => `> ${line}`).join('\n')
}

export function formatDebateRoundsMarkdown(rounds: DebateRound[], threats: ReportThreat[]): string {
  const displayIds = buildThreatDisplayIdMap(threats)
  return rounds.map((round) => {
    const provisional = round.isFinalRound === false
    const matched = matchThreats(round.threatAssessments, threats)
    const findings = round.threatAssessments.map((assessment, index) => {
      const threat = matched[index]
      const id = threat ? (threat.displayId ?? displayIds.get(threat.id)) : `Threat ${String(index + 1).padStart(2, '0')}`
      const title = threat?.title ?? assessment.threatDescription.slice(0, 100)
      const conclusion = provisional
        ? writtenFindingConclusion(assessment.interimSummary)
        : writtenFindingConclusion(assessment.judgeNotes)
      return `#### ${id} - ${title}

**Component:** ${assessment.component ?? threat?.component ?? 'Architecture'}

${assessment.consensus ? `**Team consensus:** ${provisional ? 'Pending remaining rounds' : assessment.consensus === 'agreed' ? 'Agreed' : assessment.consensus === 'disagreed' ? 'No consensus' : 'Unverified'}\n` : ''}
> **RED TEAM · ${assessment.redVerdict.toUpperCase()}**
${quote(assessment.redNotes ?? 'No separate offensive rationale was returned.')}

> **BLUE TEAM · ${assessment.blueVerdict.toUpperCase()}**
${quote(assessment.blueNotes ?? 'No separate defensive rationale was returned.')}

${assessment.redReplyNotes ? `> **RED REPLY · ${(assessment.redReplyVerdict ?? assessment.redVerdict).toUpperCase()}**\n${quote(assessment.redReplyNotes)}\n` : ''}
**${provisional ? 'Provisional' : 'Final'} disposition: ${(assessment.disposition ?? 'applicable').replaceAll('_', ' ').toUpperCase()} (${assessment.finalVerdict.toUpperCase()})**
${assessment.qualityIssues?.length ? `Review required: ${assessment.qualityIssues.join(' ')}\n\n` : ''}${conclusion ? provisional ? `Interim conclusion: ${conclusion}` : conclusion : ''}`
    }).join('\n\n')

    return `### Round ${round.round}

${findings}

${round.judgeSummary ? `#### Independent adjudication

${round.judgeSummary}` : ''}

**Round status:** ${provisional ? 'Continuing: more rounds configured' : round.convergenceSignal ? 'Team consensus reached' : round.judgeSummary ? 'No team consensus; independent adjudication recorded' : 'No team consensus; further review required'}`
  }).join('\n\n---\n\n')
}

function extractSection(source: string, start: string, ends: string[]): string {
  const startIndex = source.indexOf(start)
  if (startIndex < 0) return ''
  const contentStart = startIndex + start.length
  const endIndexes = ends.map((marker) => source.indexOf(marker, contentStart)).filter((index) => index >= 0)
  const endIndex = endIndexes.length ? Math.min(...endIndexes) : source.length
  return source.slice(contentStart, endIndex).trim()
}

function clean(value: string): string {
  return value
    .replace(/[`*_#]/g, '')
    .replace(/\bDRAFT(?:-\d+)?\b/gi, 'candidate finding')
    .replace(/\s+/g, ' ')
    .trim()
}

type ParsedDebateFinding = {
  id: string
  title: string
  component: string
  redVerdict: string
  blueVerdict: string
  finalVerdict: string
  disposition: string
  redNotes: string
  blueNotes: string
  redReplyNotes?: string
  redReplyVerdict?: string
  judgeNotes: string
  qualityIssues?: string[]
  recordedFinalVerdict?: string
  consensus?: string
  provisional?: boolean
}

export type ParsedDebateRound = {
  number: string
  redOverview: string
  blueOverview: string
  judge: string
  findings: ParsedDebateFinding[]
  isFinalRound?: boolean
  status?: string
}

function unquote(value: string): string {
  return clean(value.replace(/^>\s?/gm, ''))
}

function parseStructuredFinding(block: string): ParsedDebateFinding | null {
  const heading = /^####\s+(.+?)\s+-\s+(.+)$/m.exec(block)
  const redHeader = /^>\s*\*\*RED TEAM\s*·\s*([^*]+)\*\*\s*$/mi.exec(block)
  const blueHeader = /^>\s*\*\*BLUE TEAM\s*·\s*([^*]+)\*\*\s*$/mi.exec(block)
  const replyHeader = /^>\s*\*\*RED REPLY\s*·\s*([^*]+)\*\*\s*$/mi.exec(block)
  const finalLine = /^\*\*(?:Final|Provisional) disposition:\s*([^*(]+?)(?:\s*\(([^)]+)\))?\*\*\s*$/mi.exec(block)
  if (!heading || !redHeader || !blueHeader || !finalLine) return null

  const redStart = (redHeader.index ?? 0) + redHeader[0].length
  const blueStart = (blueHeader.index ?? 0) + blueHeader[0].length
  const finalStart = finalLine.index ?? block.length
  const judgeStart = finalStart + finalLine[0].length
  const judgeEnd = block.search(/^\*\*Round status:/mi)

  const consensusLine = /^\*\*Team consensus:\*\*\s*(.+)$/mi.exec(block)?.[1]
  const persistedReview = /^Review required:\s*(.+)$/mi.exec(block)?.[1]
  const finding: ParsedDebateFinding = {
    id: clean(heading[1] ?? 'Threat'),
    title: clean(heading[2] ?? 'Threat finding'),
    component: clean(/^\*\*Component:\*\*\s*(.+)$/mi.exec(block)?.[1] ?? 'Architecture'),
    ...(consensusLine ? { consensus: clean(consensusLine) } : {}),
    provisional: finalLine[0].includes('Provisional'),
    redVerdict: clean(redHeader[1] ?? ''),
    blueVerdict: clean(blueHeader[1] ?? ''),
    finalVerdict: clean(finalLine[2] ?? finalLine[1] ?? 'review'),
    disposition: clean(finalLine[1] ?? ''),
    redNotes: unquote(block.slice(redStart, blueHeader.index)),
    blueNotes: unquote(block.slice(blueStart, replyHeader?.index ?? finalStart)),
    ...(replyHeader ? { redReplyVerdict: clean(replyHeader[1] ?? ''),
      redReplyNotes: unquote(block.slice(replyHeader.index + replyHeader[0].length, finalStart)) } : {}),
    judgeNotes: writtenFindingConclusion(clean(block.slice(judgeStart, judgeEnd >= 0 ? judgeEnd : block.length))) ?? '',
  }
  // Current summaries persist the live debate's consensus and any review
  // issues explicitly. Re-running the copy detector after Markdown cleanup can
  // turn independent, similarly grounded reviews into false positives because
  // punctuation and role markers have been removed. Trust the persisted marker
  // when present; retain recomputation only for legacy summaries that predate it.
  const qualityIssues = persistedReview
    ? [clean(persistedReview)]
    : consensusLine
      ? []
      : debateAssessmentIssues({ redNotes: finding.redNotes, blueNotes: finding.blueNotes,
        notes: finding.judgeNotes, finalVerdict: finding.finalVerdict.toLowerCase() as DebateRound['threatAssessments'][number]['finalVerdict'] }, finding.provisional)
  return qualityIssues.length ? { ...finding, qualityIssues, recordedFinalVerdict: finding.finalVerdict,
    finalVerdict: 'unresolved', disposition: 'review required' } : finding
}

function bestThreatMatch(subject: string, threats: ReportThreat[], index: number): ReportThreat | undefined {
  if (!subject) return threats[index]
  const source = tokens(subject)
  const scored = threats.map((threat) => {
    const target = tokens(`${threat.component ?? ''} ${threat.title ?? ''} ${threat.description}`)
    return { threat, score: [...source].filter((token) => target.has(token)).length }
  }).sort((a, b) => b.score - a.score)
  return (scored[0]?.score ?? 0) > 0 ? scored[0]?.threat : threats[index]
}

export function parseStoredDebateRounds(summary: string, threats: ReportThreat[]): ParsedDebateRound[] {
  const chunks = summary.split(/(?=###\s+Round\s+\d+)/i).filter((chunk) => /###\s+Round/i.test(chunk))
  return chunks.map((chunk, roundIndex) => {
    const number = /###\s+Round\s+(\d+)/i.exec(chunk)?.[1] ?? String(roundIndex + 1)
    const findingBlocks = chunk
      .split(/(?=^####\s+)/m)
      .filter((block) => /^####\s+(?!Independent adjudication)/mi.test(block))
    const structuredFindings = findingBlocks
      .map(parseStructuredFinding)
      .filter((finding): finding is ParsedDebateFinding => finding !== null)

    if (structuredFindings.length > 0) {
      const judge = clean(extractSection(chunk, '#### Independent adjudication', ['**Round status:**']))
      const status = clean(/^\*\*Round status:\*\*\s*(.+)$/mi.exec(chunk)?.[1] ?? '')
      return { number, redOverview: '', blueOverview: '', judge, findings: structuredFindings,
        status, isFinalRound: !structuredFindings.some(finding => finding.provisional) }
    }

    const redRaw = extractSection(chunk, '**Red Team:**', ['**Blue Team:**', '**Judge:**', '**Assessments:**'])
    const blueOverview = clean(extractSection(chunk, '**Blue Team:**', ['**Judge:**', '**Assessments:**']))
    const judge = clean(extractSection(chunk, '**Judge:**', ['**Assessments:**']))
    const redPositions = [...redRaw.matchAll(/\*\*DRAFT-\d+\s+Assessment:\*\*([\s\S]*?)(?=\*\*DRAFT-\d+\s+Assessment:|\*\*Overall Conclusion:|$)/gi)]
      .map((match) => clean(match[1] ?? ''))
    const redOverview = clean(redRaw.replace(/\*\*DRAFT-\d+\s+Assessment:\*\*[\s\S]*?(?=\*\*DRAFT-\d+\s+Assessment:|\*\*Overall Conclusion:|$)/gi, ''))
    const assessmentLines = extractSection(chunk, '**Assessments:**', [])
      .split('\n')
      .filter((line) => line.trim().startsWith('-'))
    const findingCount = Math.max(redPositions.length, assessmentLines.length)
    const findings = Array.from({ length: findingCount }, (_, index) => {
      const line = assessmentLines[index] ?? ''
      const verdictMatch = /(?:→|â†’|->)\s*([^\s(]+).*?red=([^,\s)]+).*?blue=([^,\s)]+)/i.exec(line)
      const subject = clean(line.replace(/^\s*-\s*/, '').split(/(?:→|â†’|->)/)[0] ?? '')
      const threat = bestThreatMatch(subject, threats, index)
      const finalVerdict = verdictMatch?.[1] ?? threat?.severity ?? threat?.priority ?? 'review'
      return {
        id: threat?.displayId ?? `Threat ${String(index + 1).padStart(2, '0')}`,
        title: threat?.title ?? (subject || 'Threat finding'),
        component: threat?.component ?? 'Architecture',
        redVerdict: verdictMatch?.[2] ?? finalVerdict,
        blueVerdict: verdictMatch?.[3] ?? finalVerdict,
        finalVerdict,
        disposition: '',
        redNotes: redPositions[index] ?? '',
        blueNotes: '',
        judgeNotes: '',
      }
    })
    return { number, redOverview, blueOverview, judge, findings }
  })
}

export function formatStoredDebateSummary(summary: string, threats: ReportThreat[]): string {
  if (!/DRAFT-\d+/i.test(summary)) return summary
  const parsedRounds = parseStoredDebateRounds(summary, threats)
  if (parsedRounds.length > 0) {
    return parsedRounds.map((round) => {
      const overview = [
        round.redOverview ? `**Red Team round position:** ${round.redOverview}` : '',
        round.blueOverview ? `**Blue Team round response:** ${round.blueOverview}` : '',
      ].filter(Boolean).join('\n\n')
      const findings = round.findings.map((finding) => `#### ${finding.id} - ${finding.title}

**Component:** ${finding.component}

${finding.consensus ? `**Team consensus:** ${finding.consensus}\n` : ''}
> **RED TEAM · ${finding.redVerdict.toUpperCase()}**
${quote(finding.redNotes || 'Covered by the Red Team round position above.')}

> **BLUE TEAM · ${finding.blueVerdict.toUpperCase()}**
${quote(finding.blueNotes || 'Covered by the Blue Team round response above.')}

${finding.redReplyNotes ? `> **RED REPLY · ${finding.redReplyVerdict?.toUpperCase()}**\n${quote(finding.redReplyNotes)}\n` : ''}
**${finding.provisional ? 'Provisional' : 'Final'} disposition: ${(finding.disposition || finding.finalVerdict).toUpperCase()} (${finding.finalVerdict.toUpperCase()})**
${finding.provisional ? '' : writtenFindingConclusion(finding.judgeNotes) ?? ''}`).join('\n\n')

      return `### Round ${round.number}

${overview}

${findings}

${round.judge ? `#### Independent adjudication

${round.judge}` : ''}${round.status ? `\n\n**Round status:** ${round.status}` : ''}`
    }).join('\n\n---\n\n')
  }
  return summary.replace(/DRAFT-(\d+)/gi, 'Threat candidate $1')
}
