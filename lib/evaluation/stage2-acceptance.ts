import { createSourceEvidence, type SourceEvidence } from '@/lib/architecture/source-evidence'
import { applyCitationIntegrity } from '@/lib/evaluation/citation-integrity'
import { writtenFindingConclusion } from '@/lib/agents/debate-quality'
import { makePassage, type EvidencePassage } from '@/lib/rag/evidence'
import type { ArchitectureData, DebateCandidate, DebateRound } from '@/lib/models/types'

/** Synthetic review architecture. Expected answers come from these sections. */
export const STAGE2_SOURCE = `# ReviewGateway
ReviewGateway terminates TLS for tenant review exports and forwards requests to ReviewDesk.
JWT validation is disabled on ReviewGateway in this environment. Unsigned tokens are accepted at the gateway.

# Transport
ReviewGateway re-encrypts traffic to ReviewDesk origin with TLS 1.2. Plaintext is not used on the origin path.

# ReviewDesk
ReviewDesk imports untrusted support messages into draft investigation summaries.
A human reviewer must approve publication. The publishing service checks that the approver is a different authenticated employee from the draft author.
Reviewer authorization grants on the REPORTING store are unknown. The source does not document effective grants.

# Scope
ReviewDesk has no payment service, payment endpoint or card data. It cannot initiate payments.

# Control register (historical)
JWT validation is enabled on ReviewGateway.

# Control register (current operations)
JWT validation is disabled on ReviewGateway. Operations has not reconciled the historical register.
`

export type Stage2CaseKind =
  | 'supported_risk'
  | 'mitigating_control'
  | 'unknown_control'
  | 'absent_component'
  | 'foreign_rag'
  | 'contradiction'

export type Stage2Case = {
  kind: Stage2CaseKind
  draftId: string
  candidate: DebateCandidate
  /** At least one phrase from each group must appear in debate notes. */
  requiredAny: string[][]
  forbidden: string[]
  expectedDisposition: Array<NonNullable<DebateRound['threatAssessments'][number]['disposition']>>
  expectedVerdicts?: Array<DebateRound['threatAssessments'][number]['finalVerdict']>
  /** Foreign RAG may be cited; it must not be treated as architecture proof. */
  foreignRagCitationId?: string
}

export type Stage2CaseResult = {
  kind: Stage2CaseKind
  draftId: string
  passed: boolean
  issues: string[]
  interventions: number
  finalVerdict?: DebateRound['threatAssessments'][number]['finalVerdict']
  disposition?: NonNullable<DebateRound['threatAssessments'][number]['disposition']>
  consensus?: NonNullable<DebateRound['threatAssessments'][number]['consensus']>
}

export type Stage2RunEvaluation = {
  passed: boolean
  issues: string[]
  rounds: number
  cases: Stage2CaseResult[]
}

function normalize(text: string): string {
  return text.normalize('NFC').toLowerCase()
}

/** Quoting a false foreign claim to reject it is not an invention. */
export function affirmsForeignSystemFact(body: string): boolean {
  if (!/reviewdesk stores ephi|this system stores ephi/.test(body)) return false
  return !/(does not|do not|not prove|unrelated|false|invalid|out of scope|out-of-scope|not this system|cannot treat|not a fact|does not store|no ephi)/.test(body)
}

function headingId(source: SourceEvidence, heading: string): string {
  const section = source.sections.find((item) => item.heading === heading)
  if (!section) throw new Error(`Stage 2 fixture missing section ${heading}`)
  return section.id
}

export function stage2ForeignPassage(): EvidencePassage {
  return makePassage({
    id: 'system-b-ledger',
    domain: 'corporate',
    source: 'other-system.md',
    document: 'The payments ledger in System B stores ePHI without encryption.',
    metadata: { sha256: 'stage2-foreign-v1', system: 'System B' },
  }, 'stage2-foreign')
}

export function buildStage2Fixture(): {
  architecture: ArchitectureData
  cases: Stage2Case[]
  foreignPassage: EvidencePassage
} {
  const sourceEvidence = createSourceEvidence(STAGE2_SOURCE)
  sourceEvidence.extraction.attempted = sourceEvidence.sections.map((section) => section.id)
  const gateway = headingId(sourceEvidence, 'ReviewGateway')
  const transport = headingId(sourceEvidence, 'Transport')
  const desk = headingId(sourceEvidence, 'ReviewDesk')
  const scope = headingId(sourceEvidence, 'Scope')
  const historical = headingId(sourceEvidence, 'Control register (historical)')
  const current = headingId(sourceEvidence, 'Control register (current operations)')
  const foreignPassage = stage2ForeignPassage()

  const architecture: ArchitectureData = {
    systemDescription: 'ReviewDesk support review workflow',
    components: [
      { name: 'ReviewGateway', type: 'service', scope: 'external' },
      { name: 'ReviewDesk', type: 'service', scope: 'internal' },
    ],
    dataFlows: [],
    trustBoundaries: [],
    externalEntities: [],
    dataStores: [],
    apiEndpoints: [],
    deploymentInfo: '',
    mermaidDfd: '',
    techFlags: {
      hasAI: true, hasAuthSystem: true, hasDatabaseLayer: false, hasExternalIntegrations: false,
      hasFileStorage: false, hasKubernetes: false, hasMessageQueue: false, hasMicroservices: false,
    },
    sourceEvidence,
  }

  const base = {
    methodology: 'STRIDE' as const,
    confidenceScore: 0.7,
    impact: 'Incorrect investigation conclusions or unauthorized access.',
    mitigation: 'Verify the documented control or reject the out-of-scope claim.',
  }

  const cases: Stage2Case[] = [
    {
      kind: 'supported_risk',
      draftId: 'DRAFT-1',
      expectedDisposition: ['applicable', 'conditional', 'control_verification_needed'],
      expectedVerdicts: ['critical', 'high', 'medium', 'low', 'unresolved'],
      requiredAny: [
        ['jwt', 'unsigned', 'token'],
        ['disabled', 'not enabled', 'turned off', 'without validation'],
        [gateway, current, 'reviewgateway'],
      ],
      forbidden: ['payment endpoint', 'card data', 'ephi'],
      candidate: {
        ...base,
        draftId: 'DRAFT-1',
        component: 'ReviewGateway',
        description: 'An attacker presents an unsigned token at ReviewGateway because JWT validation is disabled.',
        evidenceSources: [{ sourceType: 'architecture', sourceName: gateway, excerpt: 'placeholder' }],
      },
    },
    {
      kind: 'mitigating_control',
      draftId: 'DRAFT-2',
      expectedDisposition: ['mitigated', 'conditional', 'control_verification_needed', 'invalid', 'applicable'],
      requiredAny: [
        ['tls', 're-encrypt', 'origin'],
        [transport, 'plaintext is not used', 'not used on the origin'],
      ],
      forbidden: ['no tls', 'plaintext origin is proven', 'card data'],
      candidate: {
        ...base,
        draftId: 'DRAFT-2',
        component: 'ReviewGateway',
        description: 'ReviewGateway forwards review exports to ReviewDesk origin in plaintext after TLS termination.',
        evidenceSources: [{ sourceType: 'architecture', sourceName: transport, excerpt: 'placeholder' }],
      },
    },
    {
      kind: 'unknown_control',
      draftId: 'DRAFT-3',
      expectedDisposition: ['control_verification_needed', 'conditional'],
      requiredAny: [
        ['unknown', 'not document', 'not documented', 'verification'],
        ['grant', 'reporting', 'authorization'],
      ],
      forbidden: ['grants are absent', 'no authorization exists', 'ephi'],
      candidate: {
        ...base,
        draftId: 'DRAFT-3',
        component: 'ReviewDesk',
        description: 'ReviewDesk has no authorization grants on REPORTING, so any reviewer can read every investigation.',
        evidenceSources: [{ sourceType: 'architecture', sourceName: desk, excerpt: 'placeholder' }],
      },
    },
    {
      kind: 'absent_component',
      draftId: 'DRAFT-4',
      expectedDisposition: ['invalid'],
      expectedVerdicts: ['invalid'],
      requiredAny: [
        ['no payment', 'has no payment', 'payment service', 'out of scope', 'out-of-scope'],
        [scope, 'reviewdesk'],
      ],
      forbidden: ['payment endpoint allows', 'unauthorized payment succeeds'],
      candidate: {
        ...base,
        draftId: 'DRAFT-4',
        component: 'ReviewDesk',
        description: 'The ReviewDesk payment endpoint allows an unauthorized payment.',
        evidenceSources: [{ sourceType: 'architecture', sourceName: scope, excerpt: 'placeholder' }],
      },
    },
    {
      kind: 'foreign_rag',
      draftId: 'DRAFT-5',
      expectedDisposition: ['invalid', 'control_verification_needed', 'conditional'],
      foreignRagCitationId: foreignPassage.citationId,
      requiredAny: [
        ['system b', 'other system', 'does not prove', 'not this system', 'unrelated', 'foreign', 'out of scope'],
      ],
      forbidden: ['reviewdesk payment ledger'],
      candidate: {
        ...base,
        draftId: 'DRAFT-5',
        component: 'ReviewDesk',
        description: 'ReviewDesk leaks ePHI the way the System B payments ledger does.',
        evidenceSources: [{
          sourceType: 'rag',
          sourceName: foreignPassage.citationId,
          excerpt: foreignPassage.excerpt,
        }],
      },
    },
    {
      kind: 'contradiction',
      draftId: 'DRAFT-6',
      expectedDisposition: ['control_verification_needed', 'conditional', 'applicable'],
      requiredAny: [
        ['contradict', 'conflict', 'inconsist', 'historical', 'reconcil', 'both'],
        ['enabled', 'disabled'],
        [historical, current, 'control register'],
      ],
      forbidden: ['the historical register proves jwt is enabled in production without conflict'],
      candidate: {
        ...base,
        draftId: 'DRAFT-6',
        component: 'ReviewGateway',
        description: 'JWT validation is enabled, so unsigned tokens at ReviewGateway are not a risk.',
        evidenceSources: [
          { sourceType: 'architecture', sourceName: historical, excerpt: 'placeholder' },
          { sourceType: 'architecture', sourceName: current, excerpt: 'placeholder' },
        ],
      },
    },
  ]

  return { architecture, cases, foreignPassage }
}

type Stage2Assessment = DebateRound['threatAssessments'][number]

const FINAL_VERDICTS = ['critical', 'high', 'medium', 'low', 'invalid', 'unresolved'] as const
const SIDE_VERDICTS = [...FINAL_VERDICTS, 'unavailable'] as const
const DISPOSITIONS = ['applicable', 'conditional', 'control_verification_needed', 'mitigated', 'invalid'] as const
const CONSENSUSES = ['agreed', 'disagreed', 'unverified'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeForEquality(value: string): string {
  return normalize(value).replace(/\s+/g, ' ').trim()
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function assessmentFor(round: DebateRound | undefined, draftId: string): Stage2Assessment[] {
  if (!round || !Array.isArray(round.threatAssessments)) return []
  return round.threatAssessments.filter((item) => isRecord(item) && item.draftId === draftId) as Stage2Assessment[]
}

function notesOf(rounds: DebateRound[], draftId: string): {
  text: string
  interventions: number
  latest?: Stage2Assessment
} {
  const parts: string[] = []
  let interventions = 0
  let latest: Stage2Assessment | undefined

  // The acceptance contract is exactly two Red→Blue pairs. In particular, a
  // judge note is a ruling after the dialogue and never an intervention.
  for (const round of rounds.slice(0, 2)) {
    const assessment = assessmentFor(round, draftId)[0]
    if (!assessment) continue
    latest = assessment
    for (const value of [assessment.redNotes, assessment.blueNotes]) {
      if (isNonEmptyString(value)) {
        parts.push(value)
        interventions += 1
      }
    }
  }
  return latest ? { text: parts.join('\n'), interventions, latest } : { text: parts.join('\n'), interventions }
}

function assessmentShapeIssues(assessment: Stage2Assessment, roundIndex: number): string[] {
  const issues: string[] = []
  const requiredStrings: Array<keyof Stage2Assessment> = [
    'draftId', 'threatDescription', 'notes', 'redNotes', 'blueNotes',
  ]
  for (const field of requiredStrings) {
    if (!isNonEmptyString(assessment[field])) issues.push(`Round ${roundIndex + 1} has missing or invalid ${field}.`)
  }
  if (!isOneOf(assessment.redVerdict, SIDE_VERDICTS)) issues.push(`Round ${roundIndex + 1} has invalid redVerdict.`)
  if (!isOneOf(assessment.blueVerdict, SIDE_VERDICTS)) issues.push(`Round ${roundIndex + 1} has invalid blueVerdict.`)
  if (!isOneOf(assessment.finalVerdict, FINAL_VERDICTS)) issues.push(`Round ${roundIndex + 1} has missing or invalid finalVerdict.`)
  if (assessment.redDisposition !== undefined && !isOneOf(assessment.redDisposition, DISPOSITIONS)) {
    issues.push(`Round ${roundIndex + 1} has invalid redDisposition.`)
  }
  if (assessment.blueDisposition !== undefined && !isOneOf(assessment.blueDisposition, DISPOSITIONS)) {
    issues.push(`Round ${roundIndex + 1} has invalid blueDisposition.`)
  }
  if (assessment.disposition !== undefined && !isOneOf(assessment.disposition, DISPOSITIONS)) {
    issues.push(`Round ${roundIndex + 1} has invalid disposition.`)
  }
  // DebateRound marks consensus optional for legacy/provisional reports. Keep
  // that compatibility while rejecting a malformed value when it is present.
  if (assessment.consensus !== undefined && !isOneOf(assessment.consensus, CONSENSUSES)) {
    issues.push(`Round ${roundIndex + 1} has invalid consensus.`)
  }
  if (assessment.judgeNotes !== undefined && typeof assessment.judgeNotes !== 'string') {
    issues.push(`Round ${roundIndex + 1} has invalid judgeNotes.`)
  }
  if (assessment.qualityIssues !== undefined) {
    if (!Array.isArray(assessment.qualityIssues) || assessment.qualityIssues.some((item) => typeof item !== 'string')) {
      issues.push(`Round ${roundIndex + 1} has invalid qualityIssues.`)
    }
  }
  return issues
}

export function evaluateStage2Run(params: {
  rounds: DebateRound[]
  cases: Stage2Case[]
  errors?: string[]
  source: SourceEvidence
  foreignPassage: EvidencePassage
}): Stage2RunEvaluation {
  const issues: string[] = []
  if (params.errors?.length) issues.push(...params.errors)
  const rounds = Array.isArray(params.rounds) ? params.rounds : []
  const caseStructuralIssues = new Map<string, string[]>()
  const addCaseIssue = (draftId: string, issue: string) => {
    const current = caseStructuralIssues.get(draftId) ?? []
    current.push(issue)
    caseStructuralIssues.set(draftId, current)
  }
  const expectedIds = params.cases.map((item) => item.draftId)
  const expectedIdSet = new Set(expectedIds)
  if (expectedIds.length === 0) issues.push('Stage 2 requires at least one candidate.')
  if (expectedIdSet.size !== expectedIds.length) issues.push('Stage 2 cases contain duplicate draft IDs.')
  if (rounds.length !== 2) issues.push(`Expected two debate rounds, received ${rounds.length}.`)

  for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
    const round = rounds[roundIndex]
    if (!isRecord(round)) {
      issues.push(`Round ${roundIndex + 1} is missing or invalid.`)
      continue
    }
    if (round.round !== roundIndex + 1) issues.push(`Expected chronological round ${roundIndex + 1}, received ${String(round.round)}.`)
    if (typeof round.isFinalRound !== 'boolean') issues.push(`Round ${roundIndex + 1} is missing isFinalRound.`)
    if (roundIndex === 0 && round.isFinalRound !== false) issues.push('Round 1 must not be the final round.')
    if (roundIndex === 1 && round.isFinalRound !== true) issues.push('Round 2 must be the final configured round.')
    for (const field of ['redTeamArguments', 'blueTeamArguments'] as const) {
      if (typeof round[field] !== 'string') issues.push(`Round ${roundIndex + 1} has invalid ${field}.`)
    }
    if (typeof round.convergenceSignal !== 'boolean') issues.push(`Round ${roundIndex + 1} has invalid convergenceSignal.`)
    if (round.judgeSummary !== undefined && typeof round.judgeSummary !== 'string') {
      issues.push(`Round ${roundIndex + 1} has invalid judgeSummary.`)
    }
    if (round.judgeConverged !== undefined && typeof round.judgeConverged !== 'boolean') {
      issues.push(`Round ${roundIndex + 1} has invalid judgeConverged.`)
    }
    if (roundIndex === 0 && (round.judgeSummary !== undefined || round.judgeConverged !== undefined)) {
      issues.push('The judge must wait until after the last Blue.')
    }

    if (!Array.isArray(round.threatAssessments)) {
      issues.push(`Round ${roundIndex + 1} is missing threat assessments.`)
      for (const draftId of expectedIds) addCaseIssue(draftId, `Round ${roundIndex + 1} is missing its assessment.`)
      continue
    }
    const counts = new Map<string, number>()
    for (const rawAssessment of round.threatAssessments) {
      if (!isRecord(rawAssessment) || typeof rawAssessment.draftId !== 'string' || !rawAssessment.draftId.trim()) {
        issues.push(`Round ${roundIndex + 1} contains an assessment without a valid draftId.`)
        continue
      }
      const draftId = rawAssessment.draftId
      counts.set(draftId, (counts.get(draftId) ?? 0) + 1)
      if (!expectedIdSet.has(draftId)) issues.push(`Round ${roundIndex + 1} contains unexpected candidate ${draftId}.`)
      const assessment = rawAssessment as Stage2Assessment
      const shapeIssues = assessmentShapeIssues(assessment, roundIndex)
      for (const issue of shapeIssues) {
        if (expectedIdSet.has(draftId)) addCaseIssue(draftId, issue)
        else issues.push(`${draftId}: ${issue}`)
      }
      if (roundIndex === 0 && assessment.judgeNotes !== undefined && writtenFindingConclusion(assessment.judgeNotes)) {
        addCaseIssue(draftId, 'The judge must wait until after the last Blue.')
      }
      if (roundIndex === 1 && !writtenFindingConclusion(assessment.judgeNotes)) {
        addCaseIssue(draftId, 'Round 2 is missing a finding-specific conclusion.')
      }
      if (assessment.redVerdict === 'unavailable' || assessment.blueVerdict === 'unavailable'
        || assessment.redVerdict === 'unresolved' || assessment.blueVerdict === 'unresolved') {
        addCaseIssue(draftId, `Round ${roundIndex + 1} contains an unavailable or unresolved side verdict.`)
      }
      if (Array.isArray(assessment.qualityIssues) && assessment.qualityIssues.length) {
        for (const qualityIssue of assessment.qualityIssues) {
          if (expectedIdSet.has(draftId)) addCaseIssue(draftId, `Round ${roundIndex + 1} quality issue: ${qualityIssue}`)
        }
      }
    }
    for (const draftId of expectedIds) {
      const count = counts.get(draftId) ?? 0
      if (count === 0) addCaseIssue(draftId, `Round ${roundIndex + 1} is missing its assessment.`)
      if (count > 1) addCaseIssue(draftId, `Round ${roundIndex + 1} contains duplicate assessments (${count}).`)
    }
  }

  const cases = params.cases.map((item) => {
    const caseIssues: string[] = [...(caseStructuralIssues.get(item.draftId) ?? [])]
    const notes = notesOf(rounds, item.draftId)
    if (notes.interventions < 4) {
      caseIssues.push(`Expected four interventions (Red→Blue × 2), received ${notes.interventions}.`)
    }
    const body = normalize(notes.text)
    if (!body.trim()) caseIssues.push('No debate notes were returned.')
    for (const group of item.requiredAny) {
      if (!group.some((phrase) => body.includes(normalize(phrase)))) {
        caseIssues.push(`Argument never addressed ${group.join(' / ')}.`)
      }
    }
    for (const phrase of item.forbidden) {
      if (body.includes(normalize(phrase))) caseIssues.push(`Invented or forbidden claim: ${phrase}.`)
    }
    const latest = notes.latest
    const pairAssessments = rounds.slice(0, 2).map((round) => assessmentFor(round, item.draftId)[0])
    const opening = pairAssessments[0]
    const final = pairAssessments[1]
    if (opening && final && isNonEmptyString(opening.redNotes) && isNonEmptyString(final.redNotes)
      && normalizeForEquality(opening.redNotes) === normalizeForEquality(final.redNotes)) {
      caseIssues.push('Red returned identical notes in both rounds.')
    }
    if (opening && final && isNonEmptyString(opening.blueNotes) && isNonEmptyString(final.blueNotes)
      && normalizeForEquality(opening.blueNotes) === normalizeForEquality(final.blueNotes)) {
      caseIssues.push('Blue returned identical notes in both rounds.')
    }
    for (const pair of pairAssessments) {
      if (pair && isNonEmptyString(pair.redNotes) && isNonEmptyString(pair.blueNotes)
        && normalizeForEquality(pair.redNotes) === normalizeForEquality(pair.blueNotes)) {
        caseIssues.push('Red and Blue returned identical notes for a round.')
      }
    }
    if (latest && item.expectedDisposition.length && !isOneOf(latest.disposition, DISPOSITIONS)) {
      caseIssues.push('Final disposition is required and must use a valid DebateRound disposition.')
    }
    if (item.expectedVerdicts && latest && isOneOf(latest.finalVerdict, FINAL_VERDICTS) && !item.expectedVerdicts.includes(latest.finalVerdict)) {
      caseIssues.push(`Unexpected finalVerdict ${latest.finalVerdict}.`)
    }
    if (item.expectedDisposition.length && latest && isOneOf(latest.disposition, DISPOSITIONS)
      && !item.expectedDisposition.includes(latest.disposition)) {
      caseIssues.push(`Unexpected disposition ${latest.disposition}.`)
    }
    if (item.kind === 'absent_component' && latest && latest.finalVerdict !== 'invalid' && latest.disposition !== 'invalid') {
      caseIssues.push('Absent-component case must not remain an in-scope finding.')
    }
    if (item.kind === 'unknown_control' && /no authorization exists|grants are absent/.test(body)) {
      caseIssues.push('Unknown control was treated as a proven absence.')
    }
    if (item.foreignRagCitationId) {
      const checked = applyCitationIntegrity({
        component: item.candidate.component,
        description: item.candidate.description,
        confidenceScore: item.candidate.confidenceScore,
        evidenceSources: item.candidate.evidenceSources,
      }, { source: params.source, passages: [params.foreignPassage] })
      const rag = checked.evidenceSources.find((evidence) => evidence.sourceType === 'rag')
      if (rag?.referenceStatus === 'verified' && rag.relevanceStatus === 'relevant' && rag.supportStatus === 'supports') {
        caseIssues.push('Foreign RAG was treated as supporting proof of this system.')
      }
      if (affirmsForeignSystemFact(body)) {
        caseIssues.push('Foreign RAG was presented as a ReviewDesk fact.')
      }
    }
    return {
      kind: item.kind,
      draftId: item.draftId,
      passed: caseIssues.length === 0,
      issues: caseIssues,
      interventions: notes.interventions,
      ...(latest && isOneOf(latest.finalVerdict, FINAL_VERDICTS) ? { finalVerdict: latest.finalVerdict } : {}),
      ...(latest && isOneOf(latest.disposition, DISPOSITIONS) ? { disposition: latest.disposition } : {}),
      ...(latest && isOneOf(latest.consensus, CONSENSUSES) ? { consensus: latest.consensus } : {}),
    }
  })

  for (const result of cases) {
    if (!result.passed) issues.push(`${result.draftId} (${result.kind}): ${result.issues.join(' ')}`)
  }
  return { passed: issues.length === 0, issues, rounds: params.rounds.length, cases }
}
