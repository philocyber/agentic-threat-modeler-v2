import { architectureForFindings, sourceLookup, sourceNotesCharacterBudget, SourceCoverageError } from '@/lib/architecture/source-evidence'
import { prepareFindingArchitecture } from './finding-source-context'
import { latestDebateAssessments } from './debate-quality'
import { applyCitationIntegrity, verifyEvidenceSource } from '@/lib/evaluation/citation-integrity'
import { formatPassages, type EvidenceContext } from '@/lib/rag/evidence'
import { z } from 'zod'
import { gatherEvidenceNotes, invokeAgentTwoPhase, invokeStructuredWithRetry, mapSettledWithConcurrency } from './base'
import { buildArchSummary } from './shared'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredTool } from '@langchain/core/tools'
import type { EvidenceSource } from '@/lib/db/schema'
import type { RawThreat, UnifiedThreat, DebateRound, ArchitectureData } from '@/lib/models/types'
import { dreadAverage, dreadToPriority } from '@/lib/models/scoring'
import { generateThreatId } from '@/lib/db/helpers'
import { composeAgentMessage, UNTRUSTED_INPUT_POLICY } from '@/lib/security/untrusted-input'
import { reconcileSynthesizedThreats } from './reconcile'
import { providerNameOf } from '@/lib/llm/usage'
import { agentWarn } from './logger'
import { toPublicErrorMessage } from '@/lib/utils/redact'

const DreadSchema = z.object({
  damage: z.number().min(0).max(10),
  reproducibility: z.number().min(0).max(10),
  exploitability: z.number().min(0).max(10),
  affectedUsers: z.number().min(0).max(10),
  discoverability: z.number().min(0).max(10),
  total: z.number().min(0).max(10),
})

const SynthesizedThreatSchema = z.object({
  sourceCandidateIds: z.array(z.string()).min(1).max(4),
  disposition: z.enum(['applicable', 'conditional', 'control_verification_needed', 'mitigated']),
  component: z.string().max(200),
  strideCategory: z.string().max(80).nullable().optional(),
  methodology: z.enum(['STRIDE', 'PASTA', 'ATTACK_TREE', 'DEBATE', 'SYNTHESIS']),
  description: z.string().min(80).max(500),
  impact: z.string().max(1_000),
  mitigation: z.string().max(1_500),
  controlReference: z.string().max(300).nullable().optional(),
  owaspCategories: z.array(z.string().max(100)).max(6).nullable().optional().default([]),
  attackerProfile: z.string().max(600).nullable().optional(),
  attackVector: z.string().max(800).nullable().optional(),
  reasoning: z.string().max(1_500).nullable().optional(),
  dread: DreadSchema,
  priority: z.enum(['critical', 'high', 'medium', 'low']),
  confidenceScore: z.number().min(0).max(1),
})

const OutputSchema = z.object({
  threats: z.array(SynthesizedThreatSchema),
})

export function synthesisBatchSchema(candidateIds: [string, ...string[]]) {
  return OutputSchema.extend({
    threats: z.array(SynthesizedThreatSchema.extend({
      sourceCandidateIds: z.array(z.enum(candidateIds)).min(1).max(4),
    })),
  })
}

export function synthesisPlanningSchema(candidateIds: [string, ...string[]], sourceIds: string[], budget: number) {
  const noteLimit = Math.min(160, Math.floor((budget - 700) / candidateIds.length) - 150)
  if (noteLimit < 40) throw new SourceCoverageError('Source coverage blocked: the complete candidate plan needs more output context.')
  const entry = z.strictObject({
    decision: z.enum(['retain', 'merge', 'verify', 'exclude']),
    mergeWith: z.array(z.enum(candidateIds)).max(2),
    sourceIds: z.array(sourceIds.length ? z.enum(sourceIds as [string, ...string[]]) : z.string().max(32)).max(2),
    note: z.string().min(1).max(noteLimit),
  })
  // Clip verbose hosted models instead of failing the whole synthesis plan.
  // Cursor v36 wrote a valid candidate map then died on `deduplication` > 180.
  const clip = (max: number) => z.string().transform((value) => value.slice(0, max))
  return z.strictObject({
    candidates: z.strictObject(Object.fromEntries(candidateIds.map(id => [id, entry]))),
    deduplication: clip(180),
    gaps: clip(160),
    evidenceGap: clip(250),
  })
}

// Synthesis runs batched to avoid output-token truncation: a single-shot JSON
// with ~50 threats regularly blew the output budget (same failure mode the
// validator already mitigated). Batches of this size run with bounded
// concurrency — see mapWithConcurrency call below.
// Keep deep-provider emissions small enough to finish inside the shared
// five-minute model-call deadline. Eight full findings plus source and debate
// context caused otherwise valid Kimi runs to time out before returning any
// structured output. Batches still execute with bounded concurrency, so this
// preserves every candidate without extending the deadline.
const SYNTHESIS_BATCH_SIZE = 4
const DEFAULT_SYNTHESIS_BATCH_CONCURRENCY = 3

// ─── Phase 1: evidence gathering (ReAct + RAG tools, free-text notes) ────────

const EVIDENCE_SYSTEM_PROMPT = `Build a compact synthesis plan from the original system source and candidate evidence. Return one required entry per candidate.
Use sourceIds for original source citations, mergeWith only for candidates describing the same mechanism and boundary, and the short note for unresolved conditions, contradictions and reasons for the decision.
Use verify when a plausible candidate needs control verification. Exclude only when system evidence contradicts it or it is out of scope. A retrieved example about another system is guidance, not proof about this system. Never infer absent controls from missing documentation.
Use evidenceGap for one useful retrieval question, otherwise an empty string. Full descriptions and DREAD scoring are produced in emission, which receives the original architecture and candidates. Do not reproduce the source or draft the report in this plan.`

// ─── Phase 2: emission (no tools, native structured output, batched) ─────────

const EMISSION_SYSTEM_PROMPT = `You are the chief security architect finalizing a prioritized threat model.

Convert the synthesis notes + the given candidate threats into the structured output.

Rules:
1. DEDUPLICATE: merge candidates describing the same vulnerability. Keep the most
   complete description (80-250 chars) and combine evidence sources.
2. ENRICH: complete DREAD scoring per threat (total = average of the five dimensions).
3. PRIORITIZE by DREAD total: critical >= 8.0, high >= 6.5, medium >= 4.0, low < 4.0.
4. VALIDATE: discard any threat that lacks a specific component AND an evidence source.
   Generic threats not anchored to the architecture are DISCARDED.
5. OWASP MAPPING: populate owaspCategories. Use OWASP Top 10 2021 format:
   "A01:2021 – Broken Access Control", "A02:2021 – Cryptographic Failures",
   "A03:2021 – Injection", "A04:2021 – Insecure Design", "A05:2021 – Security Misconfiguration",
   "A06:2021 – Vulnerable and Outdated Components", "A07:2021 – Identification and Authentication Failures",
   "A08:2021 – Software and Data Integrity Failures", "A09:2021 – Security Logging and Monitoring Failures",
   "A10:2021 – Server-Side Request Forgery". Use OWASP API Security Top 10 2023 when applicable:
   "API1:2023 – Broken Object Level Authorization", "API2:2023 – Broken Authentication",
   "API3:2023 – Broken Object Property Level Authorization", "API4:2023 – Unrestricted Resource Consumption",
   "API5:2023 – Broken Function Level Authorization", "API6:2023 – Unrestricted Access to Sensitive Business Flows",
   "API7:2023 – Server Side Request Forgery", "API8:2023 – Security Misconfiguration",
   "API9:2023 – Improper Inventory Management", "API10:2023 – Unsafe Consumption of APIs".
   Leave owaspCategories as [] only if no OWASP category applies.
6. PRESERVE METHODOLOGY FIELDS: attackTree is attached deterministically from the
   source candidates after emission, so do not emit or recreate it. When merging
   PASTA threats, include attackerProfile and attackVector; copy reasoning from PASTA
   when available.
7. DEBATE: prefer debate finalVerdict when assigning priority; threats marked
   final=invalid are dropped unless the notes give strong contrary evidence.
   final=unresolved means no reliable debate verdict exists. Independently assess
   the original evidence, preserve uncertainty, and never invent a medium score.

ANTI-INFLATION RULE: Do NOT give scores of 8+ unless you can justify WHY this specific
system configuration makes it that severe. Never default to medium because evidence is uncertain.
Score potential consequences separately from confidence that the weakness exists. State unknown exploit preconditions as conditional or control_verification_needed. Equal severities are valid when justified; do not force a distribution. Do not upgrade source confidence without new system-specific evidence.

Field semantics:
- description: clear, concise statement (80-250 chars) of the vulnerability
- impact: detailed explanation of potential damage
- mitigation: specific remediation steps
- confidenceScore: 0.0-1.0, calibrated
- sourceCandidateIds: exact IDs of candidates IN THIS BATCH. Never associate by component alone. Every output needs at least one candidate ID.
- disposition: preserve conditional/control_verification_needed/mitigated from debate; do not convert unknown controls into absence.
- preconditions: explicit unresolved conditions and required verification.
- mitigation: preserve complete actionable candidate mitigations. Never use ellipses to abbreviate.
- evidenceSources are attached deterministically from sourceCandidateIds after emission. Do not emit or reproduce quotations. A cost/quotas scenario must not merge with identity merely because the component is shared.`

function formatThreatsList(threats: RawThreat[], offset: number): string {
  return JSON.stringify(threats.map((t, i) => ({ ...t, candidateId: t.candidateId ?? `CAND-${offset + i + 1}` })))
}

function formatDebateSummary(debateRounds: DebateRound[]): string {
  if (debateRounds.length === 0) return 'No debate rounds.'
  return debateRounds
    .map((r) => {
      const assessments = (r.threatAssessments ?? [])
        .slice(0, 30)
        .map(
          (a) =>
            `- ${a.draftId}: "${a.threatDescription.slice(0, 120)}" red=${a.redVerdict} blue=${a.blueVerdict} final=${a.finalVerdict} disposition=${a.disposition ?? 'conditional'} | refinement=${a.notes.slice(0, 160)}`
        )
        .join('\n')
      return `Round ${r.round}:\nRed: ${r.redTeamArguments.slice(0, 500)}\nBlue: ${r.blueTeamArguments.slice(0, 500)}\nAssessments:\n${assessments || '(none)'}`
    })
    .join('\n\n')
}

function normalizeDerivedEvidence<T extends { evidenceSources: EvidenceSource[] }>(threat: T): T {
  return {
    ...threat,
    evidenceSources: threat.evidenceSources.map((evidence) =>
      evidence.sourceType === 'architecture'
      && /\bfact ledger\b/i.test(evidence.sourceName)
      && !/SRC-\d+/i.test(evidence.sourceName)
        ? { ...evidence, sourceType: 'debate' as const }
        : evidence),
  }
}

function evidenceForCandidates(candidateIds: string[], candidates: RawThreat[]): EvidenceSource[] {
  const selected = new Set(candidateIds)
  const evidence = candidates
    .filter(candidate => candidate.candidateId && selected.has(candidate.candidateId))
    .flatMap(candidate => candidate.evidenceSources)
  return [...new Map(evidence.map(source => [[
    source.sourceType,
    source.sourceName,
    source.excerpt,
  ].join('\u0000'), source])).values()]
}

function attackTreeForCandidates(candidateIds: string[], candidates: RawThreat[]) {
  const selected = new Set(candidateIds)
  return candidates.find(candidate => candidate.candidateId && selected.has(candidate.candidateId) && candidate.attackTree)?.attackTree
}

function preconditionsForCandidates(candidateIds: string[], candidates: RawThreat[]): string[] {
  const selected = new Set(candidateIds)
  return [...new Set(candidates
    .filter(candidate => candidate.candidateId && selected.has(candidate.candidateId))
    .flatMap(candidate => candidate.preconditions ?? [])
    .map(precondition => precondition.trim())
    .filter(Boolean)
    .map(precondition => precondition.slice(0, 400)))]
    .slice(0, 8)
}

export async function runThreatSynthesizer(
  llm: BaseChatModel,
  tools: StructuredTool[],
  allThreats: RawThreat[],
  debateRounds: DebateRound[],
  architecture: ArchitectureData,
  targetThreats: number,
  signal?: AbortSignal | undefined,
  reviewerLearning?: string,
  batchConcurrency: number = DEFAULT_SYNTHESIS_BATCH_CONCURRENCY,
  emissionLLM: BaseChatModel = llm,
  onBatchError?: ((message: string) => void) | undefined,
): Promise<UnifiedThreat[]> {
  if (!allThreats.length) return []
  allThreats = allThreats.map((threat, index) => ({ ...threat, candidateId: threat.candidateId ?? `CAND-${index + 1}` }))
  let sharedArchitecture: ArchitectureData | null = null
  try {
    sharedArchitecture = architectureForFindings(architecture, allThreats, llm)
  } catch (error) {
    if (!(error instanceof SourceCoverageError)) throw error
  }
  const debateSummary = formatDebateSummary(debateRounds)

  const invalidated = latestDebateAssessments(debateRounds)
    .filter((a) => a.disposition === 'invalid' || a.finalVerdict === 'invalid')
    .map((a) => a.threatDescription.slice(0, 120))

  const evidenceSystemPrompt = reviewerLearning
    ? `${EVIDENCE_SYSTEM_PROMPT}\n\n${reviewerLearning}`
    : EVIDENCE_SYSTEM_PROMPT

  // Use one global evidence plan when its complete source context fits. Large
  // source-backed runs gather evidence per candidate batch after source review.
  const evidenceContext: EvidenceContext = { passages: [] }
  const planningInput = sharedArchitecture ? `SYSTEM ARCHITECTURE:
${buildArchSummary(sharedArchitecture)}

CANDIDATE THREATS:
${formatThreatsList(allThreats, 0)}

DEBATE SUMMARY:
${debateSummary}

INVALIDATED BY DEBATE (drop unless strong contrary evidence):
${invalidated.length ? invalidated.map((t) => `- ${t}`).join('\n') : '(none)'}` : ''
  let planningSchema: ReturnType<typeof synthesisPlanningSchema> | undefined
  if (sharedArchitecture) {
    try {
      planningSchema = synthesisPlanningSchema(allThreats.map(threat => threat.candidateId!) as [string, ...string[]],
        architecture.sourceEvidence?.sections.map(section => section.id) ?? [],
        sourceNotesCharacterBudget(emissionLLM, planningInput, evidenceSystemPrompt))
    } catch (error) {
      if (!(error instanceof SourceCoverageError)) throw error
      // A global plan that cannot fit is planned per emission batch instead.
      // No candidates or source sections are dropped to make the plan fit.
    }
  }
  const notes = planningSchema ? await gatherEvidenceNotes({
    outputSchema: planningSchema,
    evidenceContext,
    llm,
    tools,
    systemPrompt: evidenceSystemPrompt,
    task: `Plan the synthesis of the ${allThreats.length} confidence-filtered candidate threats below into ~${targetThreats} unique threats.`,
    untrusted: planningInput,
    agentName: 'ThreatSynthesizer',
    // When evidence and emission use distinct model instances, evidence is the
    // lower-reasoning planning call. A remote timeout should degrade once, not
    // spend another full provider window repeating the same global plan.
    maxRetries: llm === emissionLLM ? 2 : 1,
    signal,
  }) : null

  // Phase 2: batched emission (single-shot over ~50 threats risks output
  // truncation). Batches run with bounded concurrency; each batch sees the
  // global notes + its slice of candidates.
  const synthesisBatchSize = providerNameOf(emissionLLM) === 'ollama' ? 2 : SYNTHESIS_BATCH_SIZE
  const batches: RawThreat[][] = []
  for (let i = 0; i < allThreats.length; i += synthesisBatchSize) {
    batches.push(allThreats.slice(i, i + synthesisBatchSize))
  }
  if (batches.length === 0) return []

  const perBatchTarget = Math.max(1, Math.ceil(targetThreats / batches.length))
  const emissionSystemPrompt = `${EMISSION_SYSTEM_PROMPT}\n${UNTRUSTED_INPUT_POLICY}`

  const batchResults = await mapSettledWithConcurrency(batches, Math.max(1, batchConcurrency), async (batch, batchIdx) => {
    const batchSchema = synthesisBatchSchema(batch.map(threat => threat.candidateId!) as [string, ...string[]])
    const emissionRetries = providerNameOf(emissionLLM) === 'ollama' || llm === emissionLLM ? 3 : 1
    const batchArchitecture = await prepareFindingArchitecture(architecture, batch, llm, signal, [emissionLLM])
    const batchSummary = buildArchSummary(batchArchitecture)
    const buildPayload = (batchNotes: string) => [
      'SYNTHESIS NOTES (evidence phase):',
      batchNotes,
      '',
      'SYSTEM ARCHITECTURE:',
      batchSummary,
      '',
      `CANDIDATE THREATS IN THIS BATCH (${batch.length}):`,
      formatThreatsList(batch, batchIdx * synthesisBatchSize),
      '',
      'DEBATE SUMMARY (prefer finalVerdict for priority; DROP final=invalid):',
      debateSummary,
      '',
      'INVALIDATED BY DEBATE (do not include unless you have strong contrary evidence):',
      invalidated.length ? invalidated.map((t) => `- ${t}`).join('\n') : '(none)',
    ].join('\n')

    if (notes === null) {
      return invokeAgentTwoPhase({
        llm: emissionLLM, evidenceLLM: llm, tools, evidenceContext,
        evidenceOutputSchema: synthesisPlanningSchema(batch.map(threat => threat.candidateId!) as [string, ...string[]],
          batchArchitecture.sourceEvidence?.sections.map(section => section.id) ?? [],
          sourceNotesCharacterBudget(emissionLLM, buildPayload('No evidence notes yet.'), evidenceSystemPrompt)),
        evidenceSystemPrompt, emissionSystemPrompt,
        evidenceTask: `Plan the synthesis of these ${batch.length} candidates. Preserve their evidence and qualifications; do not infer absence from unlisted source sections.`,
        evidenceUntrusted: buildPayload('No evidence notes yet.'),
        emissionTask: `Synthesize this batch into at most ${perBatchTarget} unique threats. Preserve the candidate IDs.`,
        buildEmissionUntrusted: buildPayload,
        schema: batchSchema, agentName: 'ThreatSynthesizer',
        maxRetries: emissionRetries,
        outputTokenReserve: providerNameOf(emissionLLM) === 'cursor' ? 8_192 : undefined,
        evidenceMaxRetries: llm === emissionLLM ? 2 : 1,
        preserveEvidenceNotes: true, continueOnEvidenceFailure: false,
        sourceLookup: sourceLookup(architecture, llm), signal,
      })
    }

    return invokeStructuredWithRetry({
      llm: emissionLLM,
      schema: batchSchema,
      systemPrompt: emissionSystemPrompt,
      userMessage: composeAgentMessage({
        task: `Synthesize the batch below into at most ${perBatchTarget} unique threats (batch ${batchIdx + 1}/${batches.length}).`,
        untrusted: buildPayload(notes),
        retrieved: formatPassages(evidenceContext.passages),
        closing:
          'Generate unique, deduplicated threats with DREAD scores. If there are fewer high-confidence threats, return fewer. Quality over quantity.',
      }),
      agentName: 'ThreatSynthesizer',
      // Remote deep-model batches have deterministic per-batch fallback. Do
      // not let a stalled provider retry consume the whole synthesis phase.
      maxRetries: emissionRetries,
      outputTokenReserve: providerNameOf(emissionLLM) === 'cursor' ? 8_192 : undefined,
      signal,
    })
  })

  const synthesized = batchResults.flatMap((result, batchIndex) => {
    const ids = new Set(batches[batchIndex]!.map(t => t.candidateId))
    if (result.status === 'fulfilled' && result.value.threats.every(t => t.sourceCandidateIds.length && t.sourceCandidateIds.every(id => ids.has(id)))) {
      return result.value.threats.map((threat) =>
        applyCitationIntegrity(normalizeDerivedEvidence({
          ...threat,
          preconditions: preconditionsForCandidates(threat.sourceCandidateIds, batches[batchIndex]!),
          attackTree: attackTreeForCandidates(threat.sourceCandidateIds, batches[batchIndex]!),
          evidenceSources: evidenceForCandidates(threat.sourceCandidateIds, batches[batchIndex]!),
        }), {
          ...(architecture.sourceEvidence ? { source: architecture.sourceEvidence } : {}),
          passages: evidenceContext.passages,
        }))
    }
    const reason = result.status === 'rejected'
      ? toPublicErrorMessage(result.reason, 'The batch could not produce a valid output')
      : 'The output referenced candidate IDs outside this batch'
    const message = `Synthesis batch ${batchIndex + 1}/${batches.length} failed: ${reason}; deterministic fallback preserved ${batches[batchIndex]!.length} candidates.`
    agentWarn(message)
    onBatchError?.(message)
    return batches[batchIndex]!.map((raw) => ({
      sourceCandidateIds: raw.candidateId ? [raw.candidateId] : [],
      disposition: 'conditional' as const,
      preconditions: ['Verify the candidate preconditions against the system evidence.'],
      component: raw.component,
      strideCategory: raw.strideCategory,
      methodology: raw.methodology,
      description: raw.description,
      impact: raw.impact,
      mitigation: raw.mitigation,
      controlReference: raw.controlReference,
      owaspCategories: [],
      attackerProfile: raw.attackerProfile,
      attackVector: raw.attackVector,
      attackTree: raw.attackTree,
      reasoning: raw.reasoning,
      dread: { damage: 0, reproducibility: 0, exploitability: 0, affectedUsers: 0, discoverability: 0, total: 0 },
      scoringStatus: 'unscored' as const,
      priority: 'low' as const,
      confidenceScore: raw.confidenceScore,
      evidenceSources: raw.evidenceSources.map((evidence) =>
        verifyEvidenceSource(evidence as EvidenceSource, raw, {
          ...(architecture.sourceEvidence ? { source: architecture.sourceEvidence } : {}),
          passages: evidenceContext.passages,
        })),
    }))
  })

  // Enforce priority from DREAD total and merge methodology fields from source threats
  const enriched = synthesized.map((t) => {
    const source = allThreats.find(candidate => candidate.candidateId && t.sourceCandidateIds.includes(candidate.candidateId))
    return {
      ...t,
      id: generateThreatId(),
      scoringStatus: 'scoringStatus' in t ? t.scoringStatus : 'provisional',
      dread: { ...t.dread, total: Math.round(dreadAverage(t.dread) * 10) / 10 },
      priority: dreadToPriority(Math.round(dreadAverage(t.dread) * 10) / 10),
      attackTree: t.attackTree ?? source?.attackTree,
      attackerProfile: t.attackerProfile ?? source?.attackerProfile,
      attackVector: t.attackVector ?? source?.attackVector,
      reasoning: t.reasoning ?? source?.reasoning,
      traceability: source?.traceability,
      methodologies: source?.methodologies ?? (source ? [source.methodology] : [t.methodology]),
      sourceCandidateIds: t.sourceCandidateIds,
      disposition: t.disposition,
    }
  }) as UnifiedThreat[]
  return reconcileSynthesizedThreats(enriched, allThreats, targetThreats)
}
