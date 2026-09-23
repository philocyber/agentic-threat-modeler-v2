import { z } from 'zod'
import {
  classifyInvalidDebateTurns,
  debateTurnRepairTask,
  formatNotesForRepair,
  includeOpponentInRepair,
  type InvalidDebateTurns,
  type NamedNotes,
} from './debate-repair'
import { duplicatedDebateRationale, latestDebateAssessments, repeatedOwnTurn, writtenFindingConclusion } from './debate-quality'
import { debateProfileFor, type DebateProfile } from './debate-profile'
import { toPublicErrorMessage } from '@/lib/utils/redact'
import { prepareFindingArchitecture } from './finding-source-context'
import { sourceLookup } from '@/lib/architecture/source-evidence'
import { composeAgentMessage, UNTRUSTED_INPUT_POLICY } from '@/lib/security/untrusted-input'
import { EVIDENCE_CONTRACT, formatPassages, parseEvidencePack } from '@/lib/rag/evidence'
import { invokeAgentTwoPhase, invokeStructuredWithRetry, mapSettledWithConcurrency } from './base'
import { agentLog } from './logger'
import { StructuredOutputTruncatedError } from '@/lib/llm/structured'
import { providerNameOf } from '@/lib/llm/usage'
import { isProviderBillingError } from '@/lib/llm/provider-errors'
import {
  chunkDebateBatches,
  DEFAULT_DEBATE_BATCH_CONCURRENCY,
  DEBATE_BATCH_SIZE,
  mergeDebateBatchRounds,
  previousRoundsForBatch,
} from './debate-batches'
import {
  buildBluePrefetchQuery,
  buildDebateDossier,
  buildRedPrefetchQuery,
  buildReplyPrefetchQuery,
  formatSideAssessments,
} from './debate-dossier'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredTool } from '@langchain/core/tools'
import type { ArchitectureData, DebateCandidate, DebateRound } from '@/lib/models/types'

type Verdict = 'critical' | 'high' | 'medium' | 'low' | 'invalid' | 'unresolved'
type Disposition = NonNullable<DebateRound['threatAssessments'][number]['disposition']>
type SideAssessment = { draftId: string; threatDescription: string; verdict: Verdict; disposition?: Disposition; notes: string }
type DebateOutput = { arguments: string; convergenceSignal: boolean; threatAssessments: SideAssessment[] }
/** `ratified` marks a finding the judge closed without authority to re-label it. */
type JudgeAssessment = SideAssessment & { finalVerdict: Verdict; ratified?: boolean }
type JudgeOutput = { summary: string; convergenceSignal: boolean; threatAssessments: JudgeAssessment[] }

function debateOutputReserve(llm: BaseChatModel, profile: DebateProfile): number | undefined {
  return profile.outputTokenReserve
    ?? debateProfileFor(providerNameOf(llm)).outputTokenReserve
}

const DebateWireAssessmentSchema = z.object({
  draftId: z.string(),
  threatDescription: z.string(),
  notes: z.string().trim().min(1).transform((value) => value.slice(0, 1_200))
    .describe('In at most 1,200 characters, reason about the source and the opponent’s premise BEFORE choosing applicability/severity. Give your role-specific conclusion for this exact candidate, its architecture anchor, control effect and limitations. Explicitly distinguish an absent required component from an undocumented control.'),
  applicability: z.enum(['supported', 'conditional', 'control_verification_needed', 'mitigated', 'out_of_scope', 'contradicted', 'no_architecture_anchor'])
    .describe('Must match YOUR notes. If the source explicitly excludes a required component, choose out_of_scope. Missing control/test details mean conditional or control_verification_needed. Do not copy a prior assessment label or invent an undocumented feature to preserve a rejected scenario.'),
  severity: z.enum(['critical', 'high', 'medium', 'low']).nullable()
    .describe('Residual severity of the scenario under the stated preconditions; null for rejected or unassessable scenarios. Uncertainty is not a severity.'),
})
type WireAssessment = z.infer<typeof DebateWireAssessmentSchema>
type WireSide = { arguments: string; convergenceSignal: boolean; threatAssessments: WireAssessment[] }
type WireJudge = { summary: string; convergenceSignal: boolean; threatAssessments: WireAssessment[] }

/** Pure wire schema: provider-side and local validation can safely run twice. */
export function debateBatchSchema(ids: [string, ...string[]]): z.ZodType<WireSide>
export function debateBatchSchema(ids: [string, ...string[]], judge: true): z.ZodType<WireJudge>
export function debateBatchSchema(ids: [string, ...string[]], judge = false): z.ZodType {
  const entries = z.array(DebateWireAssessmentSchema.extend({ draftId: z.enum(ids) })).length(ids.length)
    .superRefine((items, ctx) => {
      if (new Set(items.map(item => item.draftId)).size !== ids.length) {
        ctx.addIssue({ code: 'custom', message: 'Return every requested draftId exactly once, without omissions or duplicates.' })
      }
    })
  const adjudicatedEntries = entries.superRefine((items, ctx) => {
    for (const [index, item] of items.entries()) {
      const rejected = ['out_of_scope', 'contradicted', 'no_architecture_anchor'].includes(item.applicability)
      if (!rejected && item.severity === null) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'severity'],
          message: 'The final judge must assign residual severity to a plausible scenario under its stated preconditions. Use null only when rejecting the scenario.',
        })
      }
    }
  })
  return judge
    ? z.object({ summary: z.string().transform((value) => value.slice(0, 1_200)), convergenceSignal: z.boolean(), threatAssessments: adjudicatedEntries })
    : z.object({ arguments: z.string().transform((value) => value.slice(0, 1_200)), convergenceSignal: z.boolean(), threatAssessments: entries })
}

/** Applicability is separate from severity; normalization never invents a score. */
export function normalizeDebateAssessment(item: WireAssessment): SideAssessment {
  const rejected = ['out_of_scope', 'contradicted', 'no_architecture_anchor'].includes(item.applicability)
  const verdict = rejected ? 'invalid' : item.severity ?? 'unresolved'
  const disposition = rejected ? 'invalid' : item.applicability === 'supported' ? 'applicable' : item.applicability as Disposition
  return { draftId: item.draftId, threatDescription: item.threatDescription, notes: item.notes, verdict, disposition }
}

const DEBATE_EVIDENCE_RULES = `The original architecture is authoritative. RAG examples from another system are background, never facts about this system. An irrelevant RAG citation does not disprove an independently supported architecture scenario. An undocumented control is unknown, not absent and not proof the scenario is invalid. Agreement is allowed; never invent opposition or a vulnerability. Use invalid for out-of-scope, contradicted or unsupported scenarios; use conditional/control_verification_needed for plausible scenarios with unknown preconditions. Do not assign severity merely to preserve candidate counts.`
export const RED_EVIDENCE_PROMPT = `You are a senior red-team operator. The SYSTEM ARCHITECTURE block is the system under review; RAG is for techniques, not proof that a flaw exists here. For every DRAFT-n, evaluate a high-level risk hypothesis: the named architecture element, plausible failure mechanism, necessary preconditions and limiting evidence. Stay at design-review level, without exploitation instructions. Write concise prose notes by exact DRAFT-n. Do not emit JSON. ${DEBATE_EVIDENCE_RULES}`
export const RED_EMISSION_PROMPT = `You are the Red Team risk reviewer. Convert the evidence notes into assessments; when no separate evidence pass exists, derive that analysis directly from the dossier. Assess every supplied DRAFT-n identifier exactly once. Copy draftId exactly. In notes, explain the architecture anchor, risk mechanism, prerequisites and uncertainty from YOUR source analysis. Do not write a generic evidence-rejection paragraph. ${DEBATE_EVIDENCE_RULES}`
export const BLUE_EVIDENCE_PROMPT = `You are a senior defensive security architect. Independently review every DRAFT-n before seeing Red's response. The SYSTEM ARCHITECTURE block and its fact ledger are the source of truth for documented controls. Identify each relevant control by id/name, what it actually guarantees, its coverage limits and the specific verification needed when it is unknown. RAG supplies control patterns; it does not prove a control exists here. Write concise prose notes by exact DRAFT-n, not JSON. ${DEBATE_EVIDENCE_RULES}`
export const BLUE_EMISSION_PROMPT = `You are the Blue Team defensive reviewer. Convert evidence notes into assessments; when no separate evidence pass exists, derive your control analysis directly from the dossier. Assess every supplied DRAFT-n identifier exactly once. Copy draftId exactly. Use YOUR independently reasoned control analysis to respond to Red. In notes, identify the premise you accept or challenge, the documented control or unknown control, its effect on the scenario and a concrete verification question. Do not repeat or lightly rephrase Red's rationale. Agreement on verdict is allowed, but your control analysis must support it independently. ${DEBATE_EVIDENCE_RULES}`
export const RED_REPLY_EVIDENCE_PROMPT = `You are a senior red-team operator in rebuttal. For every listed DRAFT-n, respond to Blue's specific control analysis against the original architecture. Identify the premise you accept or challenge, then state the remaining high-level risk precondition or concede with evidence. An unchanged verdict still needs a substantive response to Blue. Do not copy either earlier response, invent a bypass or force disagreement. Write concise prose notes by exact DRAFT-n identifiers. Do not emit JSON. ${DEBATE_EVIDENCE_RULES}`
export const RED_REPLY_EMISSION_PROMPT = `You are the Red Team replying to Blue. Convert the rebuttal notes into assessments for the listed DRAFT-n identifiers only; when no separate evidence pass exists, reason directly from the dossier and Blue's last premise. Copy each draftId exactly. Notes must explicitly address Blue's control premise, state whether you accept it, and explain what changes or remains uncertain. Agreement is allowed; copying Blue or repeating your opening case is not a reply. ${DEBATE_EVIDENCE_RULES}`
export const BLUE_REPLY_EVIDENCE_PROMPT = `You are the Blue Team in a later debate round. Respond to Red's CURRENT reply using the original architecture, your previous control assessment and the dialogue so far. For each DRAFT-n, identify the premise Red accepted or challenged, then explain whether its reply changes your control assessment. Address the remaining uncertainty or concede with evidence. Agreement is allowed; do not copy Red, repeat your previous answer or invent a control. Stay at design-review level. Write concise prose notes by exact DRAFT-n, not JSON. ${DEBATE_EVIDENCE_RULES}`
export const BLUE_REPLY_EMISSION_PROMPT = `You are the Blue Team replying to Red. Convert the defensive reply notes into assessments for every listed DRAFT-n exactly once; when no separate evidence pass exists, reason directly from the dossier and Red's current premise. Notes must explicitly respond to Red's current premise and explain which position you maintain or revise, with source evidence and remaining verification questions. This is your turn in the dialogue, not a judge's decision. Do not copy either team or force agreement. ${DEBATE_EVIDENCE_RULES}`
export const JUDGE_PROMPT = `You are an independent security judge closing each supplied DRAFT finding. Preserve every listed draftId exactly. For every DRAFT-n, write a finding-specific conclusion: the architecture premise that stands, the residual applicability and severity under stated preconditions, and the remaining verification question or the source fact that rejects the scenario. Do not write process status, do not say the dialogue continues, and do not say only that the teams agreed. Agreement on labels is not a conclusion; name this finding’s residual risk or the reason it is out of scope. When the teams already agree, do not reopen labels unless the original source contradicts them. When they disagree or both propose rejection, identify the disputed premise and settle it from the architecture. Before rejecting a candidate, identify the absent required architecture element or the source fact that contradicts its mechanism. The presence of a control limits the scenario; it does not disprove a failure mode that control does not address. Missing implementation or test details are verification questions, not a contradiction. For a plausible scenario, assign residual severity under the stated preconditions; severity may be null only when the scenario is rejected. ${DEBATE_EVIDENCE_RULES}`


/**
 * Provisional rounds used to end with a process-status sentence, so a reader saw
 * "the dialogue continues" instead of what the round actually established. This
 * judge only narrates; it assigns no labels, so an interim close can never
 * pre-empt the final adjudication.
 *
 * Gated on `profile.interimConclusions` (ollama only today) because it is one
 * extra call per batch per provisional round.
 * Kimi leaves this false in debate-profile.ts. A provisional hosted judge
 * doubled v15's already-slow debate for a close the UI treats as non-final.
 * Cursor can enable the flag in debate-profile.ts if that provider wants it.
 */
export const INTERIM_JUDGE_PROMPT = `You are an independent security judge summarising an unfinished debate round. For every listed DRAFT-n, state what this round established for that specific finding: the architecture premise both teams now accept, the point still in dispute, and the concrete question the next round must answer. Write about this finding's substance. Do not assign applicability or severity, do not say the dialogue continues, and do not say only that the teams agreed or disagreed. ${DEBATE_EVIDENCE_RULES}`

function interimJudgeSchema(ids: [string, ...string[]]) {
  return z.object({
    threatAssessments: z.array(z.object({
      draftId: z.enum(ids),
      notes: z.string().trim().min(1).transform((value) => value.slice(0, 1_200))
        .describe('What this round settled for this candidate and the specific question the next round must answer. No applicability or severity labels.'),
    })).length(ids.length),
  })
}

function defaultDisposition(verdict: Verdict): Disposition {
  return verdict === 'invalid' ? 'invalid' : verdict === 'unresolved' ? 'control_verification_needed' : 'applicable'
}

function assessmentMap<T extends { draftId: string }>(assessments: T[]): Map<string, T> {
  return new Map(assessments.map((assessment) => [assessment.draftId, assessment]))
}

export function isContested(
  red: Pick<SideAssessment, 'verdict' | 'disposition'> | undefined,
  blue: Pick<SideAssessment, 'verdict' | 'disposition'> | undefined,
): boolean {
  if (!red || !blue) return true
  if (red.verdict === 'unresolved' || blue.verdict === 'unresolved') return true
  if (red.verdict !== blue.verdict) return true
  const redDisposition = red.disposition ?? defaultDisposition(red.verdict)
  const blueDisposition = blue.disposition ?? defaultDisposition(blue.verdict)
  return redDisposition !== blueDisposition
}

export function contestedDraftIds(params: {
  candidates: DebateCandidate[]
  red: DebateOutput
  blue: DebateOutput
}): string[] {
  const redById = assessmentMap(params.red.threatAssessments)
  const blueById = assessmentMap(params.blue.threatAssessments)
  return params.candidates
    .filter((candidate) => isContested(redById.get(candidate.draftId), blueById.get(candidate.draftId)))
    .map((candidate) => candidate.draftId)
}

/** Deterministically joins outputs by stable draft ID, never by text similarity. */
export function mergeAssessments(
  candidates: DebateCandidate[],
  redResult: DebateOutput,
  blueResult: DebateOutput,
  judgeResult?: JudgeOutput,
  isFinalRound = true,
  previous?: DebateRound['threatAssessments'],
  copyContainment?: number,
): DebateRound['threatAssessments'] {
  const redById = assessmentMap(redResult.threatAssessments)
  const blueById = assessmentMap(blueResult.threatAssessments)
  const judgeById = assessmentMap(judgeResult?.threatAssessments ?? [])
  const previousById = assessmentMap(previous ?? [])
  return candidates.map((candidate) => {
    const red = redById.get(candidate.draftId)
    const blue = blueById.get(candidate.draftId)
    const judge = judgeById.get(candidate.draftId)
    const prior = previousById.get(candidate.draftId)
    const redVerdict = red?.verdict ?? 'unavailable'
    const blueVerdict = blue?.verdict ?? 'unavailable'
    const agreed = !isContested(red, blue)
    const qualityIssues: string[] = []
    if (!red || !blue) qualityIssues.push('A team did not return an assessment for this candidate.')
    if (duplicatedDebateRationale(red?.notes, blue?.notes, copyContainment)) qualityIssues.push('Red and Blue returned copied or nearly identical reasoning; independent review is unverified.')
    if (repeatedOwnTurn(red?.notes, prior?.redNotes, copyContainment) || repeatedOwnTurn(blue?.notes, prior?.blueNotes, copyContainment)) {
      qualityIssues.push('A team repeated its previous turn instead of answering the latest opposing argument.')
    }
    if (isFinalRound && !agreed && !judge) qualityIssues.push('The teams disagree and no adjudication settled the finding.')
    if (isFinalRound && judge && !writtenFindingConclusion(judge.notes)) {
      qualityIssues.push('This finding has no written conclusion.')
    }
    const ruled = judge && !judge.ratified
    if ((ruled && judge.finalVerdict === 'unresolved') || (!ruled && (red?.verdict === 'unresolved' || blue?.verdict === 'unresolved'))) qualityIssues.push('A severity could not be assessed for the plausible scenario.')
    const copiedOrMissing = !red || !blue || duplicatedDebateRationale(red.notes, blue.notes, copyContainment)
      || repeatedOwnTurn(red?.notes, prior?.redNotes, copyContainment) || repeatedOwnTurn(blue?.notes, prior?.blueNotes, copyContainment)
    // A ratified entry is the judge closing a finding the teams already settled:
    // its prose is the conclusion, but the labels stay with the teams. Without
    // this the widened judge coverage would let an adjudicator overturn a
    // consensus the prompt explicitly told it not to reopen.
    const ruling = judge && !judge.ratified ? judge : undefined
    const finalVerdict = qualityIssues.length || (!agreed && !judge) ? 'unresolved' as const : ruling?.finalVerdict ?? red!.verdict
    const disposition = finalVerdict === 'unresolved' ? 'control_verification_needed' as const : ruling?.disposition
      ?? red?.disposition
      ?? blue?.disposition
      ?? defaultDisposition(finalVerdict)
    const conclusion = writtenFindingConclusion(judge?.notes)
    return {
      draftId: candidate.draftId,
      threatDescription: candidate.description,
      component: candidate.component,
      methodology: candidate.methodology,
      redVerdict,
      blueVerdict,
      redDisposition: red?.disposition,
      blueDisposition: blue?.disposition,
      consensus: copiedOrMissing || red.verdict === 'unresolved' || blue.verdict === 'unresolved'
        ? 'unverified' as const : agreed ? 'agreed' as const : 'disagreed' as const,
      finalVerdict,
      disposition,
      qualityIssues,
      redNotes: red?.notes ?? 'No offensive rationale returned.',
      blueNotes: blue?.notes ?? 'No defensive rationale returned.',
      ...(conclusion ? { judgeNotes: conclusion } : {}),
      notes: conclusion
        ? `Conclusion: ${conclusion} | Red: ${red?.notes ?? 'no assessment'} | Blue: ${blue?.notes ?? 'no assessment'}`
        : `Red: ${red?.notes ?? 'no assessment'} | Blue: ${blue?.notes ?? 'no assessment'}`,
    }
  })
}

/**
 * Under `judgeCoverage: 'contested'` an agreed finding gets no ruling, so its
 * close comes from Blue's own last notes instead of a second hosted call.
 *
 * This runs after the merge quality checks, never before: a synthetic result
 * assembled earlier would let copied or missing Blue prose arrive as
 * `judgeNotes` while independent-review validation was still pending.
 */
function closeAgreedFromBlue(params: {
  assessment: DebateRound['threatAssessments'][number]
  issues: string[]
  isFinalRound: boolean
  profile: DebateProfile
}): string | undefined {
  if (!params.isFinalRound || params.profile.judgeCoverage !== 'contested'
    || params.assessment.judgeNotes || params.assessment.consensus !== 'agreed'
    || params.issues.length || params.assessment.finalVerdict === 'unresolved') return undefined
  const close = writtenFindingConclusion(params.assessment.blueNotes)
  return close ? `Team conclusion (agreed): ${close}` : undefined
}

type SideCall = {
  profile: DebateProfile
  llm: BaseChatModel
  evidenceLLM?: BaseChatModel | undefined
  tools: StructuredTool[]
  evidenceSystemPrompt: string
  emissionSystemPrompt: string
  agentName: string
  task: string
  dossier: string
  evidenceDossier?: string
  draftIds: [string, ...string[]]
  onEvidence?: (notes: string) => void
  prefetchQuery: string
  sourceLookup?: ((query: string) => string) | undefined
  signal?: AbortSignal | undefined
}

function mergeDebateOutputs(parts: DebateOutput[]): DebateOutput {
  return {
    arguments: parts.map((part) => part.arguments).filter(Boolean).join('\n\n'),
    convergenceSignal: parts.every((part) => part.convergenceSignal),
    threatAssessments: parts.flatMap((part) => part.threatAssessments),
  }
}

function namedNotes(items: Array<{ draftId: string; notes: string }>): NamedNotes[] {
  return items.map((item) => ({ draftId: item.draftId, notes: item.notes }))
}

async function repairInvalidSide(params: {
  profile: DebateProfile
  llm: BaseChatModel
  systemPrompt: string
  agentName: string
  current: DebateOutput
  invalid: InvalidDebateTurns
  independentDossier: string
  opponentNotes?: NamedNotes[]
  previousOwn?: NamedNotes[]
  evidenceNotes: string
  evidenceLabel: string
  signal?: AbortSignal | undefined
}): Promise<DebateOutput> {
  let current = params.current
  let invalid = params.invalid
  const repairLimit = params.profile.verifyRepairs ? 2 : 1
  for (let attempt = 0; attempt < repairLimit && invalid.ids.length; attempt += 1) {
    const ids = invalid.ids as [string, ...string[]]
    const wanted = new Set(ids)
    const opponentBlock = includeOpponentInRepair(invalid) && params.opponentNotes?.length
      ? `\n\nOPPONENT ARGUMENT YOU MUST ANSWER:\n${formatNotesForRepair(params.opponentNotes.filter((item) => wanted.has(item.draftId)))}`
      : ''
    const evidenceBlock = params.evidenceNotes.trim()
      ? `\n\n${params.evidenceLabel}\n${params.evidenceNotes}`
      : ''
    const [repair] = await mapSettledWithConcurrency([ids], 1, (repairIds) => invokeStructuredWithRetry({
      llm: params.llm,
      schema: debateBatchSchema(repairIds),
      systemPrompt: `${params.systemPrompt}\n${EVIDENCE_CONTRACT}\n${UNTRUSTED_INPUT_POLICY}`,
      userMessage: composeAgentMessage({
        task: debateTurnRepairTask(repairIds, invalid),
        untrusted: `${params.independentDossier}${opponentBlock}${evidenceBlock}`,
      }),
      agentName: params.agentName,
      maxRetries: 1,
      outputTokenReserve: debateOutputReserve(params.llm, params.profile),
      signal: params.signal,
    }))
    if (repair?.status !== 'fulfilled') return current
    const byId = assessmentMap(repair.value.threatAssessments.map(normalizeDebateAssessment))
    const assessments = current.threatAssessments.map((item) => byId.get(item.draftId) ?? item)
    current = { ...current, arguments: formatSideAssessments(assessments), threatAssessments: assessments }
    if (!params.profile.verifyRepairs) return current
    invalid = classifyInvalidDebateTurns({
      current: namedNotes(current.threatAssessments),
      ...(params.opponentNotes ? { opponent: params.opponentNotes } : {}),
      ...(params.previousOwn ? { previousOwn: params.previousOwn } : {}),
      copyContainment: params.profile.copyContainment,
    })
  }
  return current
}

async function assessSide(params: SideCall): Promise<DebateOutput> {
  try {
    // Hosted models keep the one-call path when the dossier is sufficient.
    // Both paths may request one optional RAG lookup for a specific gap.
    const result = params.profile.evidenceMode === 'embedded'
      ? await (async () => {
          // Kimi/Cursor: one structured call. Do not concatenate the evidence
          // prompt because it says "Do not emit JSON" and fights the schema.
          // Ollama keeps invokeAgentTwoPhase below; do not delete that path.
          let emitted = await invokeStructuredWithRetry({
            llm: params.llm,
            schema: debateBatchSchema(params.draftIds),
            // Keep the same trust boundary and evidence semantics as the
            // two-phase helper. The only optimization is removing the redundant
            // free-text generation, not weakening how source text is handled.
            systemPrompt: `${params.emissionSystemPrompt} There is no prior evidence pass. Reason in each notes field from the dossier before choosing labels. RAG is optional. Only if a material factual question remains that retrieval could resolve, put EVIDENCE_GAP: <specific question> in the relevant notes field. Otherwise do not request retrieval.\n${EVIDENCE_CONTRACT}\n${UNTRUSTED_INPUT_POLICY}`,
            userMessage: composeAgentMessage({
              task: `${params.task} Preserve every requested ID (${params.draftIds.join(', ')}). Keep each notes field within 1,200 characters.`,
              // Blue's opening still sees Red here: a one-shot turn has to
              // answer Red. Independence is the prompt + copy detector, not a
              // hidden evidence pass. evidenceDossier stays for two_phase.
              untrusted: params.dossier,
            }),
            agentName: params.agentName,
            maxRetries: 2,
            outputTokenReserve: debateOutputReserve(params.llm, params.profile),
            signal: params.signal,
          })
          const gap = emitted.threatAssessments
            .map(item => item.notes.match(/EVIDENCE_GAP:\s*(.{12,500})/i)?.[1]?.trim())
            .find((value): value is string => Boolean(value))
          if (gap && params.tools[0]) {
            try {
              const pack = parseEvidencePack(await params.tools[0].invoke({ query: gap, facets: [params.prefetchQuery] },
                params.signal ? { signal: params.signal } : undefined))
              if (pack?.passages.length) {
                const revised = await invokeStructuredWithRetry({
                  llm: params.llm,
                  schema: debateBatchSchema(params.draftIds),
                  systemPrompt: `${params.emissionSystemPrompt} Revise only where the additional retrieved evidence supports a change. Preserve every requested ID, source limitations and unknowns. No more searches are available.\n${EVIDENCE_CONTRACT}\n${UNTRUSTED_INPUT_POLICY}`,
                  userMessage: composeAgentMessage({
                    task: `${params.task} Preserve every requested ID (${params.draftIds.join(', ')}).`,
                    untrusted: `${params.dossier}\n\nEXISTING ASSESSMENT:\n${JSON.stringify(emitted)}`,
                    retrieved: formatPassages(pack.passages),
                  }),
                  agentName: params.agentName,
                  maxRetries: 2,
                  outputTokenReserve: debateOutputReserve(params.llm, params.profile),
                  signal: params.signal,
                })
                const knownIds = new Set([
                  ...pack.passages.map(passage => passage.citationId),
                  ...[...params.dossier.matchAll(/\bRAG-[a-f0-9]{24}\b/gi)].map(match => match[0]),
                ].map(id => id.toLowerCase()))
                const claimedIds = [...JSON.stringify(revised).matchAll(/\bRAG-[a-f0-9]{24}\b/gi)].map(match => match[0])
                if (claimedIds.some(id => !knownIds.has(id.toLowerCase()))) {
                  throw new Error('Revised debate assessment cited a RAG passage absent from the delivered evidence.')
                }
                emitted = revised
              }
            } catch (error) {
              if (params.signal?.aborted || (error instanceof Error && error.name === 'AbortError')
                || error instanceof StructuredOutputTruncatedError || isProviderBillingError(error)) throw error
              agentLog(`[${params.agentName}] optional RAG lookup or revision unavailable; retaining architecture-based assessment`)
            }
          }
          // Repair still needs "our notes". Previously this stayed empty on
          // embedded and a Kimi copy-repair had nothing of its own to keep.
          params.onEvidence?.(emitted.threatAssessments.map((item) => `${item.draftId}: ${item.notes}`).join('\n'))
          return emitted
        })()
      : await invokeAgentTwoPhase({
          llm: params.llm,
          evidenceLLM: params.evidenceLLM,
          tools: params.tools,
          evidenceSystemPrompt: params.evidenceSystemPrompt,
          evidenceTask: params.task,
          evidenceUntrusted: params.evidenceDossier ?? params.dossier,
          prefetchQuery: params.prefetchQuery,
          emissionSystemPrompt: params.emissionSystemPrompt,
          emissionTask: params.task,
          buildEmissionUntrusted: (notes) => {
            params.onEvidence?.(notes)
            return `${params.dossier}\n\nYOUR INDEPENDENT EVIDENCE NOTES:\n${notes}`
          },
          emissionClosing: `Preserve every requested ID (${params.draftIds.join(', ')}). Keep each notes field within 1,200 characters. Reason from your own role-specific evidence before selecting labels. Applicability and severity must match your notes: an explicitly absent required component is out_of_scope with severity=null; unknown control coverage is a verification question. Do not inherit labels from the other team.`,
          schema: debateBatchSchema(params.draftIds),
          agentName: params.agentName,
          maxRetries: 2,
          outputTokenReserve: debateOutputReserve(params.llm, params.profile),
          evidenceMaxRetries: params.evidenceLLM ? 1 : 2,
          continueOnEvidenceFailure: !params.dossier.includes('[SRC-'),
          preserveEvidenceNotes: params.dossier.includes('[SRC-'),
          sourceLookup: params.sourceLookup,
          signal: params.signal,
        })
    return { ...result, threatAssessments: result.threatAssessments.map(normalizeDebateAssessment) }
  } catch (error) {
    if (!(error instanceof StructuredOutputTruncatedError) || params.draftIds.length <= 1 || params.signal?.aborted) {
      throw error
    }
    const split = Math.ceil(params.draftIds.length / 2)
    agentLog(`[${params.agentName}] Splitting ${params.draftIds.length} debate IDs after output truncation; every ID remains required.`)
    const left = await assessSide({
      ...params,
      draftIds: params.draftIds.slice(0, split) as [string, ...string[]],
    })
    const right = await assessSide({
      ...params,
      draftIds: params.draftIds.slice(split) as [string, ...string[]],
    })
    return mergeDebateOutputs([left, right])
  }
}

export type DebateRoundInput = {
  redLLM: BaseChatModel
  blueLLM: BaseChatModel
  evidenceLLM?: BaseChatModel | undefined
  judgeLLM?: BaseChatModel | undefined
  tools: { red: StructuredTool[]; blue: StructuredTool[] }
  threats: DebateCandidate[]
  previousRounds: DebateRound[]
  roundNumber: number
  /** Adjudicate only after the final configured Red/Blue pair. */
  isFinalRound?: boolean | undefined
  architecture?: ArchitectureData | null | undefined
  signal?: AbortSignal | undefined
  /** Provider tuning. Derived from the Red model's provider when omitted. */
  profile?: DebateProfile | undefined
  /** Reuses source review for the same candidate batch across configured rounds. */
  architectureCache?: Map<string, Promise<ArchitectureData>> | undefined
  batchSize?: number | undefined
  batchConcurrency?: number | undefined
  onBatchError?: ((message: string) => void) | undefined
}

async function runDebateBatch(input: DebateRoundInput): Promise<DebateRound> {
  const profile = input.profile ?? debateProfileFor(providerNameOf(input.redLLM))
  const previousRounds = previousRoundsForBatch(input.previousRounds, input.threats)
  let reviewArchitecture = input.architecture
  if (input.architecture) {
    const cacheKey = input.threats.map((threat) => threat.draftId).join('|')
    let prepared = input.architectureCache?.get(cacheKey)
    if (!prepared) {
      prepared = prepareFindingArchitecture(input.architecture, input.threats, input.evidenceLLM ?? input.redLLM, input.signal, [input.redLLM, input.blueLLM, input.judgeLLM ?? input.redLLM])
      // A large-source relevance review is independent of the dialogue. Share
      // its promise across rounds, and also across concurrent callers, so the
      // expensive SourceReview model pass happens once per stable batch.
      input.architectureCache?.set(cacheKey, prepared)
    }
    try {
      reviewArchitecture = await prepared
    } catch (error) {
      if (input.architectureCache?.get(cacheKey) === prepared) input.architectureCache.delete(cacheKey)
      throw error
    }
  }
  const dossier = buildDebateDossier({
    architecture: reviewArchitecture,
    model: input.evidenceLLM ?? input.redLLM,
    threats: input.threats,
    previousRounds,
  })
  const independentDossier = buildDebateDossier({ architecture: reviewArchitecture,
    model: input.evidenceLLM ?? input.redLLM, threats: input.threats, previousRounds: [] })
  const draftIds = input.threats.map(threat => threat.draftId) as [string, ...string[]]
  const isReply = previousRounds.length > 0
  const isFinalRound = input.isFinalRound ?? true
  const roundTask = `Round ${input.roundNumber}. Assess every draftId in the architecture dossier below.`
  const lookup = input.architecture ? sourceLookup(input.architecture, input.evidenceLLM ?? input.redLLM) : undefined
  const previousAssessments = latestDebateAssessments(previousRounds)
  const previousBlue = previousAssessments.map((item) => ({ draftId: item.draftId, notes: item.blueNotes ?? '' }))
  const previousRed = previousAssessments.map((item) => ({ draftId: item.draftId, notes: item.redNotes ?? '' }))
  const redDossier = isReply
    ? `${dossier}\n\nBLUE'S LAST ARGUMENT YOU MUST ANSWER:\n${formatNotesForRepair(previousBlue)}`
    : dossier
  let redEvidence = ''
  let redResult = await assessSide({
    profile,
    llm: input.redLLM,
    evidenceLLM: input.evidenceLLM,
    tools: input.tools.red,
    evidenceSystemPrompt: isReply ? RED_REPLY_EVIDENCE_PROMPT : RED_EVIDENCE_PROMPT,
    emissionSystemPrompt: isReply ? RED_REPLY_EMISSION_PROMPT : RED_EMISSION_PROMPT,
    agentName: isReply ? 'RedTeamReply' : 'RedTeam',
    task: isReply ? `${roundTask} Reply to Blue's last turn. Explain what you accept or challenge and why. Do not repeat your previous notes.` : roundTask,
    dossier: redDossier,
    draftIds,
    onEvidence: notes => { redEvidence = notes },
    prefetchQuery: isReply ? buildReplyPrefetchQuery(input.threats) : buildRedPrefetchQuery(input.threats),
    sourceLookup: lookup,
    signal: input.signal,
  })
  if (isReply) {
    redResult = await repairInvalidSide({
      profile,
      llm: input.redLLM,
      systemPrompt: RED_REPLY_EMISSION_PROMPT,
      agentName: 'RedTeamReplyRepair',
      current: redResult,
      invalid: classifyInvalidDebateTurns({
        current: namedNotes(redResult.threatAssessments),
        opponent: previousBlue,
        previousOwn: previousRed,
        copyContainment: profile.copyContainment,
      }),
      independentDossier,
      opponentNotes: previousBlue,
      previousOwn: previousRed,
      evidenceNotes: redEvidence,
      evidenceLabel: 'YOUR REBUTTAL NOTES:',
      signal: input.signal,
    })
  }
  const blueDossier = `${dossier}\n\nRED ASSESSMENTS YOU MUST ANSWER:\n${formatSideAssessments(redResult.threatAssessments, false)}`
  let blueEvidence = ''
  let blueResult = await assessSide({
    profile,
    llm: input.blueLLM,
    evidenceLLM: input.evidenceLLM,
    tools: input.tools.blue,
    evidenceSystemPrompt: isReply ? BLUE_REPLY_EVIDENCE_PROMPT : BLUE_EVIDENCE_PROMPT,
    emissionSystemPrompt: isReply ? BLUE_REPLY_EMISSION_PROMPT : BLUE_EMISSION_PROMPT,
    agentName: isReply ? 'BlueTeamReply' : 'BlueTeam',
    task: isReply ? `${roundTask} Respond to Red's current reply before this round can end. Do not repeat your previous notes.` : roundTask,
    dossier: blueDossier,
    evidenceDossier: isReply ? blueDossier : independentDossier,
    draftIds,
    onEvidence: notes => { blueEvidence = notes },
    prefetchQuery: buildBluePrefetchQuery(input.threats, input.architecture),
    sourceLookup: lookup,
    signal: input.signal,
  })
  blueResult = await repairInvalidSide({
    profile,
    llm: input.blueLLM,
    systemPrompt: isReply ? BLUE_REPLY_EMISSION_PROMPT : BLUE_EMISSION_PROMPT,
    agentName: isReply ? 'BlueTeamReplyRepair' : 'BlueTeamIndependentReview',
    current: blueResult,
    invalid: classifyInvalidDebateTurns({
      current: namedNotes(blueResult.threatAssessments),
      opponent: namedNotes(redResult.threatAssessments),
      ...(isReply ? { previousOwn: previousBlue } : {}),
      copyContainment: profile.copyContainment,
    }),
    independentDossier,
    opponentNotes: namedNotes(redResult.threatAssessments),
    ...(isReply ? { previousOwn: previousBlue } : {}),
    evidenceNotes: blueEvidence,
    evidenceLabel: 'YOUR INDEPENDENT CONTROL NOTES:',
    signal: input.signal,
  })

  // A round is exactly one turn per team. Later rounds contain both replies;
  // no extra Red turn can follow Blue inside this round.
  const remainingContested = contestedDraftIds({
    candidates: input.threats, red: redResult, blue: blueResult,
  })
  // Rejection removes a finding from downstream synthesis. Require an
  // independent source review even when both actors propose rejecting it.
  const proposedRejections = redResult.threatAssessments.filter(item => item.verdict === 'invalid'
    && blueResult.threatAssessments.some(blue => blue.draftId === item.draftId && blue.verdict === 'invalid')
    && !duplicatedDebateRationale(item.notes, blueResult.threatAssessments.find(blue => blue.draftId === item.draftId)?.notes, profile.copyContainment)).map(item => item.draftId)
  const openingContested = previousRounds.flatMap(round => round.threatAssessments
    .filter(item => item.redVerdict !== item.blueVerdict || item.redDisposition !== item.blueDisposition)
    .map(item => item.draftId))
  const contestedSet = new Set([...openingContested, ...remainingContested])
  const agreedIds = draftIds.filter((id) => !contestedSet.has(id) && !proposedRejections.includes(id))
  // `all` sends every draftId so each finding is closed by the adjudicator;
  // `contested` skips it where the labels already match and closes those
  // findings from Blue's notes instead.
  const judgeIds = (profile.judgeCoverage === 'all'
    ? draftIds
    : [...new Set([...contestedSet, ...proposedRejections])]) as string[]
  let judgeResult: JudgeOutput | undefined
  let interimConclusions: Map<string, string> | undefined
  if (isFinalRound && input.judgeLLM && judgeIds.length) {
    const requestedJudgeIds = judgeIds as [string, ...string[]]
    const judgeIdSet = new Set(requestedJudgeIds)
    const judgeThreats = input.threats.filter((threat) => judgeIdSet.has(threat.draftId))
    const judgeDossier = profile.judgeCoverage === 'contested'
      ? buildDebateDossier({ architecture: reviewArchitecture,
          model: input.evidenceLLM ?? input.redLLM, threats: judgeThreats,
          previousRounds: previousRoundsForBatch(previousRounds, judgeThreats) })
      : dossier
    const agreedCloseInstruction = profile.judgeCoverage === 'all'
      ? `AGREED DRAFT IDS (write a finding-specific close; do not reopen labels unless the source contradicts them): ${agreedIds.join(', ') || 'none'}`
      : `AGREED DRAFT IDS (already settled from Blue; do not emit them): ${agreedIds.join(', ') || 'none'}`
    const judgment = await invokeStructuredWithRetry({
      llm: input.judgeLLM,
      schema: debateBatchSchema(requestedJudgeIds, true),
      systemPrompt: `${JUDGE_PROMPT}\n${EVIDENCE_CONTRACT}\n${UNTRUSTED_INPUT_POLICY}`,
      userMessage: composeAgentMessage({
        task: `Round ${input.roundNumber}. Close every requested finding (${requestedJudgeIds.join(', ')}). Write a conclusion for each listed DRAFT-n. Do not emit other findings.`,
        untrusted: [
          // A contested-only judge receives only the findings it can rule on.
          // This cuts hosted input without removing their source-backed dossier.
          judgeDossier,
          agreedCloseInstruction,
          `CONTESTED DRAFT IDS: ${[...contestedSet].join(', ') || 'none'}`,
          `INDEPENDENT APPLICABILITY REVIEW IDS: ${proposedRejections.join(', ') || 'none'}`,
          `CURRENT RED ASSESSMENTS:\n${formatSideAssessments(redResult.threatAssessments.filter(item => judgeIdSet.has(item.draftId)), false)}`,
          `CURRENT BLUE ASSESSMENTS:\n${formatSideAssessments(blueResult.threatAssessments.filter(item => judgeIdSet.has(item.draftId)), false)}`,
        ].join('\n\n'),
      }),
      agentName: 'DebateJudge',
      maxRetries: 2,
      outputTokenReserve: debateOutputReserve(input.judgeLLM, profile),
      signal: input.signal,
    })
    // `ratified` withholds label authority on findings the teams already
    // settled: the judge's prose is kept, its verdict discarded. Under
    // `contested` those IDs are absent from the payload entirely.
    const agreedSet = new Set(agreedIds)
    judgeResult = {
      ...judgment,
      threatAssessments: judgment.threatAssessments.map(item => {
        const assessment = normalizeDebateAssessment(item)
        return { ...assessment, finalVerdict: assessment.verdict, ratified: agreedSet.has(item.draftId) }
      }),
    }
  } else if (!isFinalRound && profile.interimConclusions && input.judgeLLM) {
    // Provisional round: narrate each finding without deciding it.
    const interim = await invokeStructuredWithRetry({
      llm: input.judgeLLM,
      schema: interimJudgeSchema(draftIds),
      systemPrompt: `${INTERIM_JUDGE_PROMPT}\n${EVIDENCE_CONTRACT}\n${UNTRUSTED_INPUT_POLICY}`,
      userMessage: composeAgentMessage({
        task: `Round ${input.roundNumber} of a longer debate. Summarise where each finding stands (${draftIds.join(', ')}). Assign no labels.`,
        untrusted: [
          dossier,
          `CURRENT RED ASSESSMENTS:\n${formatSideAssessments(redResult.threatAssessments, false)}`,
          `CURRENT BLUE ASSESSMENTS:\n${formatSideAssessments(blueResult.threatAssessments, false)}`,
        ].join('\n\n'),
      }),
      agentName: 'DebateInterimJudge',
      maxRetries: 1,
      outputTokenReserve: debateOutputReserve(input.judgeLLM, profile),
      signal: input.signal,
    }).catch((error) => {
      // An interim close is commentary. Losing it must not lose the round.
      agentLog(`[DebateInterimJudge] Round ${input.roundNumber} close unavailable: ${toPublicErrorMessage(error, 'interim adjudication failed')}`)
      return undefined
    })
    if (interim) interimConclusions = new Map(interim.threatAssessments.map(item => [item.draftId, item.notes]))
  }

  // Keep the LLM result separate from the Kimi team close. Only an actual
  // adjudicator may populate round-level judge summary and convergence fields.
  const llmJudge = judgeResult

  const previousById = assessmentMap(latestDebateAssessments(previousRounds))
  const threatAssessments = mergeAssessments(
    input.threats, redResult, blueResult, judgeResult, isFinalRound,
    latestDebateAssessments(previousRounds), profile.copyContainment,
  ).map(item => {
    const previous = previousById.get(item.draftId)
    const issues = [...(item.qualityIssues ?? [])]
    if (duplicatedDebateRationale(previous?.redNotes, item.redNotes, profile.copyContainment)) issues.push('Red repeated its previous turn instead of responding to Blue.')
    if (duplicatedDebateRationale(previous?.blueNotes, item.redNotes, profile.copyContainment)) issues.push('Red copied Blue’s previous turn instead of independently responding.')
    if (duplicatedDebateRationale(previous?.blueNotes, item.blueNotes, profile.copyContainment)) issues.push('Blue repeated its previous turn instead of responding to Red.')
    // A provisional round has no judge ruling. Keep that narration in its own
    // field so neither the next pair nor acceptance treats it as adjudication.
    const interim = interimConclusions?.get(item.draftId)
    const teamConclusion = closeAgreedFromBlue({ assessment: item, issues, isFinalRound, profile })
    const finalConclusion = item.judgeNotes ?? teamConclusion
    return { ...item,
      consensus: issues.length > (item.qualityIssues?.length ?? 0) ? 'unverified' as const : item.consensus,
      finalVerdict: issues.length ? 'unresolved' as const : item.finalVerdict,
      qualityIssues: [...new Set(issues)],
      ...(interim ? { interimSummary: interim } : {}),
      // `judgeNotes` is the persisted final-close slot for compatibility. In
      // contested-only mode an independently written Blue close can occupy it
      // only after clean team agreement; it is labeled as a team conclusion.
      ...(finalConclusion ? { judgeNotes: finalConclusion,
        notes: `Conclusion: ${finalConclusion} | Red: ${item.redNotes ?? 'no assessment'} | Blue: ${item.blueNotes ?? 'no assessment'}` } : {}),
    }
  })
  return {
    round: input.roundNumber,
    isFinalRound,
    redTeamArguments: redResult.arguments,
    blueTeamArguments: blueResult.arguments,
    convergenceSignal: isFinalRound && threatAssessments.every(item => item.consensus === 'agreed' && !item.qualityIssues?.length),
    threatAssessments,
    // Round-level summary is only from the LLM judge. A Kimi all-agreed batch
    // has per-finding closes from Blue and no synthetic "teams agreed" banner.
    ...(llmJudge ? { judgeSummary: llmJudge.summary, judgeConverged: llmJudge.convergenceSignal } : {}),
  }
}

export async function runDebateRound(input: DebateRoundInput): Promise<DebateRound> {
  const profile = input.profile ?? debateProfileFor(providerNameOf(input.redLLM))
  const batches = chunkDebateBatches(input.threats, input.batchSize ?? profile.batchSize ?? DEBATE_BATCH_SIZE)

  const settled = await mapSettledWithConcurrency(
    batches,
    input.batchConcurrency ?? profile.batchConcurrency ?? DEFAULT_DEBATE_BATCH_CONCURRENCY,
    (batch) => runDebateBatch({ ...input, profile, threats: batch }),
  )
  const results = settled.map((result, batchIndex) => {
    if (result.status === 'fulfilled') return result.value
    const batch = batches[batchIndex]!
    input.onBatchError?.(`Debate batch ${batchIndex + 1}/${batches.length} unavailable; candidates remain unreviewed. ${toPublicErrorMessage(result.reason, 'Debate review failed')}`)
    return {
      round: input.roundNumber,
      isFinalRound: input.isFinalRound ?? true,
      redTeamArguments: '',
      blueTeamArguments: '',
      convergenceSignal: false,
      threatAssessments: batch.map((candidate) => ({
        draftId: candidate.draftId,
        threatDescription: candidate.description,
        component: candidate.component,
        methodology: candidate.methodology,
        redVerdict: 'unavailable' as const,
        blueVerdict: 'unavailable' as const,
        finalVerdict: 'unresolved' as const,
        consensus: 'unverified' as const,
        disposition: 'control_verification_needed' as const,
        notes: 'Batch evaluation unavailable; candidate preserved without a debate verdict.',
        qualityIssues: ['The debate batch did not complete.'],
      })),
    }
  })
  const round = mergeDebateBatchRounds(
    input.roundNumber,
    results,
    input.threats.map((threat) => threat.draftId),
  )
  return round
}
