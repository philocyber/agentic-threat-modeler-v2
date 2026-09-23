import { applyCitationIntegrity } from '@/lib/evaluation/citation-integrity'
import { sourceLookup } from '@/lib/architecture/source-evidence'
import { prepareFindingArchitecture } from './finding-source-context'
import { buildArchSummary } from './shared'
import { z } from 'zod'
import { invokeAgentTwoPhase, mapSettledWithConcurrency } from './base'
import { providerNameOf } from '@/lib/llm/usage'
import { providerBatchConcurrency } from '@/lib/llm/execution-profiles'
import { StructuredOutputTruncatedError } from '@/lib/llm/structured'
import { agentLog } from './logger'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredTool } from '@langchain/core/tools'
import type { UnifiedThreat } from '@/lib/models/types'
import { dreadToPriority, normalizeThreatScore, priorityBandsPromptText } from '@/lib/models/scoring'
import {
  EMPTY_VALIDATOR_CONTEXT,
  formatControlsBlock,
  formatValidatorThreat,
  type ValidatorContext,
} from './dread-context'

const CorrectedThreatSchema = z.object({
  id: z.string().max(100),
  title: z.string().max(200)
    .describe('Architectural threat pattern (generic, reusable) - REQUIRED'),
  // Providers sometimes return a complete, valid batch with a rationale a few
  // hundred characters over the storage budget. Rejecting every score in that
  // batch loses useful work over presentation length, so apply the bound after
  // parsing instead of making it a batch-fatal validation constraint.
  scoringRationale: z.string().transform((value) => value.slice(0, 1_200)).optional(),
  scoringStatus: z.enum(['validated', 'provisional', 'unscored']).optional()
    .describe('Use unscored when dimensions cannot be assessed; zero placeholders are not validated scores.'),
  dread: z.object({
    damage: z.number().min(0).max(10),
    reproducibility: z.number().min(0).max(10),
    exploitability: z.number().min(0).max(10),
    affectedUsers: z.number().min(0).max(10),
    discoverability: z.number().min(0).max(10),
    /**
     * Reported for the model's own benefit, never trusted: the total is
     * recomputed below as the average of the five dimensions. Constraining it
     * to 0-10 rejected whole batches over a discarded number, because summing
     * the five (35, 50) is the reading models reach for, measured on both
     * Ollama and Kimi. Optional and unbounded, so a natural answer costs nothing.
     */
    total: z.number().optional(),
  }),
  correctionReason: z.string().transform((value) => value.slice(0, 200)).optional(),
})

/** Exported so tests exercise the shape the pipeline actually sends. */
export const DreadValidatorOutputSchema = z.object({
  validations: z.array(CorrectedThreatSchema),
})
const OutputSchema = DreadValidatorOutputSchema

export function validatorBatchSchema(ids: [string, ...string[]]) {
  return OutputSchema.extend({
    validations: z.array(CorrectedThreatSchema.extend({ id: z.enum(ids) })).length(ids.length)
      .superRefine((items, ctx) => {
        if (new Set(items.map(item => item.id)).size !== ids.length) {
          ctx.addIssue({ code: 'custom', message: 'Return exactly one validation for every input threat ID, without duplicates.' })
        }
      }),
  })
}

// ─── Phase 1: evidence gathering (ReAct + RAG tools, free-text notes) ────────

export const EVIDENCE_SYSTEM_PROMPT = `You are a security risk management specialist preparing to enrich threats with
validated DREAD scores and architectural context.

For EACH threat in the batch, use the RAG tools where useful (documented patterns,
control references) and write analysis NOTES covering:
- The generic architectural threat pattern name (reusable, no component names)
- How the attack works at architectural level from the adversary perspective
- Which documented architecture elements and trust boundaries affect the score
- DREAD assessment: closest documented pattern + per-dimension reasoning against
  the DOCUMENTED CONTROLS listed with the batch. A control listed as enabled is
  a fact about this system: say which dimensions it caps and why. A control that
  appears nowhere in the ledger or the threat text is unknown, not absent.
  Preserve that uncertainty and state which control verification is needed;
  do not turn missing documentation into evidence of a missing control.
- If an enabled control makes the threat conditional, state the precondition an
  attacker still has to satisfy. That is the useful finding, not a re-scored
  worst case.

OUTPUT OF THIS PHASE: structured analysis NOTES in prose, NOT JSON. One labeled
section per threat ID.`

// ─── Phase 2: emission (no tools, native structured output) ──────────────────

export const EMISSION_SYSTEM_PROMPT = `You are a security risk management specialist enriching threat models with DREAD scores and architectural context.

**DREAD Formula:** (D + R + E + A + D) / 5 = Score (0.0-10.0)

Your job for EVERY threat:
1. Refactor the title to architectural pattern style (generic, reusable).
2. Review each DREAD dimension independently using the scoring anchors (adjust if needed).
3. Emit only the fields in the schema. Description, impact, mitigation, classification,
   traceability, citations and preconditions are preserved deterministically from the
   validated synthesis result; do not reproduce or modify them.
Do not equate evidence confidence with severity, default unknowns to 5, or force findings into different bands. Preserve conditional language when the exploit is unverified. Retain the original system-specific subject and limitations when editing titles.

---

## DREAD SCORING GRID (Anchors on a continuous 0–10 scale)

### D - Damage Potential
- **0**: No damage (theoretical vulnerability)
- **3**: Single user/session affected
- **5**: Multiple users in one tenant/company
- **7**: All tenants/complete system (API/DB down, mass financial manipulation)
- **9**: Infrastructure compromise (DB credentials, JWT secrets exposed)
- **10**: Total destruction or irrecoverable loss

**Key Rules:**
- APIs without auth: D >= 7
- PII exposure unencrypted: D = 7-9
- Financial transaction manipulation: D = 9-10
- DoS non-critical component: D = 3-5
- DoS critical component (payments, auth): D = 7-8

### R - Reproducibility
- **0**: Nearly impossible (extreme race conditions)
- **5**: Moderate effort (2-3 steps, custom scripts, internal knowledge, network access, temporal event)
- **7**: Consistently reproducible (1-2 steps with standard tools, BUT requires prior auth or VPC access)
- **10**: Trivially reproducible (single HTTP request, no preconditions, FROM INTERNET)

**Key Rules:**
- Missing M2M auth: R = 10
- No input validation: R = 10
- Race condition in business logic: R = 5-7
- Configuration flaw (hardcoded secrets): R = 10

### E - Exploitability
- **1**: Extremely difficult (physical access, reverse engineering, deep internals knowledge)
- **2**: Advanced skills (zero-day, custom exploits, admin auth required)
- **5**: Moderate skills (public exploit, normal user auth, known tools like SQLMap/Burp)
- **7**: No auth required (public exploit, automated tools)
- **10**: Trivial (browser only, copy/paste URL, modify query param, curl)

**Key Rules:**
- Public API no auth + documented: E = 10
- Public API no auth + undocumented: E = 7
- SQL Injection with WAF: E = 5
- SQL Injection without WAF: E = 7
- HTTP header manipulation: E = 10
- IDOR: E = 10

### A - Affected Users
- **0**: No users (test environment)
- **3**: Specific user (requires knowing victim's ID/RUC)
- **5**: Multiple users in ONE tenant/company
- **7**: Significant portion (10-50% of user base)
- **10**: ALL users

**Key Rules:**
- No auth on public endpoint: A = 10
- IDOR without ownership validation: A = 10
- Internal M2M endpoint exposure: A = 10 (if discovered)
- Missing RUC/tenant validation: A = 10
- DoS on shared component: A = 10

### D - Discoverability
- **0**: Impossible (requires source code AND privileged system access)
- **2**: Very difficult (reverse engineering, encrypted traffic analysis, advanced fuzzing)
- **5**: Discoverable with effort (API response analysis, input testing, unencrypted network monitoring)
- **7**: Easily discoverable (public API docs like Swagger, verbose errors)
- **9**: Public domain (published CVE, security articles, social media posts)
- **10**: Visible at a glance (URL in browser, query params, HTTP headers unencrypted, docs expose insecure design)

**Key Rules:**
- Endpoint in Swagger without auth: D = 10
- Undocumented but fuzzable: D = 5-7
- Trusted HTTP header (X-User-Id) in OpenAPI spec: D = 10
- PII in accessible logs: D = 7-9
- No TLS (plain HTTP): D = 10
- Verbose error messages with stack traces: D = 9-10

---

## COMMON PATTERNS (STRIDE → DREAD)

Use these as starting points, then adjust:

| Pattern | D | R | E | A | D | Total | Notes |
|---------|---|---|---|---|---|-------|-------|
| **Missing M2M auth between internal APIs** | 7 | 10 | 7 | 10 | 7 | **8.2** | Any internal attacker can invoke critical APIs |
| **Trusted HTTP headers (X-User-Id)** | 7 | 10 | 10 | 10 | 10 | **9.4** | Trivially falsifiable, documented |
| **No input validation (SQL Injection)** | 9 | 10 | 7 | 10 | 9 | **9.0** | Complete DB compromise |
| **IDOR without ownership check** | 7 | 10 | 10 | 10 | 7 | **8.8** | Classic IDOR |
| **No logging of critical operations** | 5 | 10 | 5 | 10 | 2 | **6.4** | Can't audit, but limited damage |
| **PII in transit without TLS** | 7 | 10 | 10 | 10 | 10 | **9.4** | Trivial network sniffing |
| **PII in logs without masking** | 7 | 10 | 5 | 10 | 7 | **7.8** | Requires log access |
| **Hardcoded credentials in code** | 9 | 10 | 7 | 10 | 9 | **9.0** | Public/private repos compromised |
| **No rate limiting on public endpoint** | 7 | 10 | 10 | 10 | 9 | **9.2** | Trivial DDoS |
| **No rate limiting on OTP** | 5 | 10 | 7 | 10 | 9 | **8.2** | Enables brute force |
| **Role validation bypass** | 9 | 10 | 7 | 10 | 7 | **8.6** | Admin function access |

---

## REDUCTION CRITERIA (Controls Present)

Apply these adjustments IF controls are explicitly documented:

- **WAF with updated rules**: E: -2
- **API Gateway with OAuth2/JWT**: E: -3, D: -2
- **Effective rate limiting**: E: -2 (DoS), D: -1
- **Network segmentation (private VPC)**: D: -2, A: -2
- **Universal TLS 1.3 encryption**: E: -1, D: -3 (Info Disclosure)
- **Logging + SIEM with alerts**: D: +2 (more visible)
- **Schema validation (OpenAPI)**: E: -2 (Tampering)

**CRITICAL:** A control that appears nowhere in the documented-controls list and
nowhere in the threat text has UNKNOWN status. Missing documentation is not proof of absence. Do not invent either protection or a bypass; record the unresolved precondition.

## CEILING RULES (documented + enabled controls)

These are caps, not suggestions. When the batch lists a control as enabled and it
covers the threat's path, the score MUST respect the ceiling and correctionReason
MUST name the control:

| Documented control (enabled) | Ceiling |
|---|---|
| Parameterized queries / ORM on the affected path | R <= 5, E <= 5 |
| JWT validation enabled on the affected route | R <= 5, E <= 5 |
| Rate limiting on the affected route | R <= 6 for DoS/brute-force, E <= 5 |
| TLS in transit on the affected hop | E <= 4, Disc <= 4 for interception threats |
| Network isolation (private subnet/VPC) | R <= 5, A <= 7 |
| Signed requests / HMAC on the affected call | R <= 5, E <= 5 |
| Encryption at rest on the affected store | D <= 6 for disclosure-at-rest |
| Audit logging + SIEM on the affected action | Disc may rise; D <= 6 for repudiation |

A threat that survives an enabled control is a COVERAGE or BYPASS finding: score
the residual path, not the unprotected one.

## LOW-RISK ANCHORS (the grid is not one-directional)

Not every finding is severe. These are calibrated examples of what LOW and
MEDIUM look like. Use them as anchors just like the high-severity table:

| Pattern | D | R | E | A | Disc | Total |
|---------|---|---|---|---|------|-------|
| Verbose error message without secrets, authenticated route | 2 | 6 | 4 | 3 | 5 | **4.0** |
| Missing security header (X-Frame-Options) on an API-only origin | 2 | 7 | 5 | 3 | 7 | **4.8** |
| DoS on a non-critical async worker with a retry queue | 3 | 6 | 5 | 3 | 4 | **4.2** |
| Info disclosure of non-sensitive metadata (build version) | 1 | 8 | 6 | 3 | 8 | **5.2** |
| Repudiation gap on a low-value read endpoint with request logs | 2 | 5 | 4 | 3 | 3 | **3.4** |
| IDOR on a resource the user already owns (no cross-tenant path) | 2 | 6 | 6 | 2 | 5 | **4.2** |

CALIBRATION CHECK before emitting: a batch where every threat lands >= 8.0 is
almost always wrong. Rank within the batch. If two threats differ in real
severity, their totals must differ too.

---

## ENRICHMENT RULES

### 1. DREAD Validation
- **Check threat description** for architecture context
- **Match to closest pattern** in the grid above
- **Adjust each dimension** based on specific context
- **Document justification** (correctionReason, max 150 chars) for any score >= 8

### 2. Title Refactoring (Architectural Pattern Style)
- Write a GENERIC architectural threat pattern name
- DO NOT mention specific components, endpoints, or versions in title
- Examples:
  ✅ "JWT Token Forgery"
  ✅ "SQL Injection via User Input"
  ✅ "Insecure Direct Object Reference"
  ❌ "Backend API: The GET /api/users/:id endpoint lacks authorization"

### 3. Preserved Finding Fields
The pipeline carries description, classifications, impact, mitigation, traceability,
preconditions and citations forward from synthesis. Do not emit copies of them.

---
## OUTPUT REQUIREMENTS

**MANDATORY for EVERY threat (one entry per input threat ID):**
1. ✅ MUST provide "id" - copied EXACTLY from the input threat
2. ✅ MUST provide "title" - architectural pattern (generic)
3. ✅ MUST provide "dread" - validated scores
4. "correctionReason" - only if DREAD scores were adjusted (max 150 chars)
5. "scoringRationale" - explain Damage, Reproducibility, Exploitability, Affected Users, and Discoverability individually, including unresolved assumptions. Required even if unchanged; maximum 1,200 characters.

---
## PRIORITY BANDS (derived from the total; the pipeline recomputes them)

${priorityBandsPromptText()}

## DEBATE RULING (when the batch shows one)

Red/Blue/Judge already argued this threat against the documented controls, so
their reasoning supplies context, not a target numeric band:
- Independently score all five dimensions against the original evidence.
- Do not work backwards from finalVerdict to force a matching total.
- Explain material disagreement in correctionReason.
- residual=mitigated or a named enabled control means the ceiling rules apply.`

const DEFAULT_VALIDATOR_CONCURRENCY = 3
export const VALIDATOR_BATCH_SIZE = 5

export function validatorBatchSize(llm: BaseChatModel): number {
  return providerNameOf(llm) === 'ollama' ? 3 : VALIDATOR_BATCH_SIZE
}

export function validatorConcurrency(llm: BaseChatModel, requested = DEFAULT_VALIDATOR_CONCURRENCY): number {
  return providerBatchConcurrency(providerNameOf(llm), requested)
}

export type DreadValidatorOptions = {
  signal?: AbortSignal | undefined
  concurrency?: number | undefined
  maxRetries?: number | undefined
  evidenceMaxRetries?: number | undefined
  /** Architecture + debate context; without it the ceiling rules have no facts. */
  context?: ValidatorContext | undefined
  onBatchError?: ((message: string) => void) | undefined
}

export async function runDreadValidator(
  llm: BaseChatModel,
  tools: StructuredTool[],
  threats: UnifiedThreat[],
  options: DreadValidatorOptions = {},
): Promise<UnifiedThreat[]> {
  if (threats.length === 0) return threats
  const signal = options.signal
  const concurrency = validatorConcurrency(llm, options.concurrency)
  const context = options.context ?? EMPTY_VALIDATOR_CONTEXT
  const controlsBlock = formatControlsBlock(context)

  // Process ALL threats for enrichment (title/description/traceability refactoring).
  // Hosted batches use five findings. Local structured output is capped lower,
  // so Ollama starts with three instead of wasting two doomed generations and
  // reaching the recursive split only after truncation.
  const batchSize = validatorBatchSize(llm)
  const batches: UnifiedThreat[][] = []
  for (let i = 0; i < threats.length; i += batchSize) {
    batches.push(threats.slice(i, i + batchSize))
  }

  const runBatch = async (batch: UnifiedThreat[]): Promise<z.infer<typeof OutputSchema>> => {
    const threatsList = batch
      .map((threat) => formatValidatorThreat(threat, context))
      .join('\n\n---\n\n')
    const originals = context.architecture ? buildArchSummary(await prepareFindingArchitecture(context.architecture, batch, llm, signal)) : ''
    const payload = `${originals}\n\n${controlsBlock}\n\nTHREATS IN THIS BATCH (${batch.length}):\n\n${threatsList}`

    try {
      return await invokeAgentTwoPhase({
      llm,
      tools,
      evidenceSystemPrompt: EVIDENCE_SYSTEM_PROMPT,
      evidenceTask: `Analyze the ${batch.length} threats below and prepare enrichment notes. Score each one against the documented controls and, where present, the debate ruling.`,
      evidenceUntrusted: payload,
      emissionSystemPrompt: EMISSION_SYSTEM_PROMPT,
      emissionTask:
        'Convert your enrichment notes into one validation entry per threat ID. The original threats are the source of truth for IDs and preserved fields.',
      buildEmissionUntrusted: (notes) =>
        `Enrichment analysis notes:\n\n${notes}\n\nOriginal threats:\n\n${payload}`,
      emissionClosing:
        'Emit one validation entry per threat ID now. Apply only controls documented on the affected path. Justify each dimension independently; do not force a score distribution.',
      schema: validatorBatchSchema(batch.map(threat => threat.id) as [string, ...string[]]),
      agentName: 'DreadValidator',
      maxRetries: options.maxRetries ?? 2,
      outputTokenReserve: providerNameOf(llm) === 'cursor' ? 4_096 : undefined,
      evidenceMaxRetries: options.evidenceMaxRetries ?? options.maxRetries ?? 2,
      continueOnEvidenceFailure: !context.architecture?.sourceEvidence,
      preserveEvidenceNotes: Boolean(context.architecture?.sourceEvidence),
      sourceLookup: context.architecture ? sourceLookup(context.architecture, llm) : undefined,
      signal,
      })
    } catch (error) {
      if (!(error instanceof StructuredOutputTruncatedError) || batch.length <= 1 || signal?.aborted) throw error
      const split = Math.ceil(batch.length / 2)
      agentLog(`[DreadValidator] Splitting ${batch.length} findings after output truncation; every ID remains required.`)
      // Keep the split serial within each worker, so local recovery cannot
      // increase concurrency or escape the existing run deadline.
      const left = await runBatch(batch.slice(0, split))
      const right = await runBatch(batch.slice(split))
      return { validations: [...left.validations, ...right.validations] }
    }
  }
  const batchResults = await mapSettledWithConcurrency(batches, concurrency, runBatch)

  const allEnrichments = new Map<string, z.infer<typeof CorrectedThreatSchema>>()
  for (const [batchIndex, result] of batchResults.entries()) {
    if (result.status === 'rejected') {
      options.onBatchError?.(`DREAD batch ${batchIndex + 1}/${batches.length} failed; original scores were preserved.`)
      continue
    }
    for (const validation of result.value.validations) {
      allEnrichments.set(validation.id, validation)
    }
  }

  // Apply enrichments to all threats
  return threats.map((t) => {
    const enrichment = allEnrichments.get(t.id)

    // If no enrichment found (LLM didn't process this threat), return with fallback title
    if (!enrichment) {
      return applyCitationIntegrity({
        ...t,
        title: t.title || (t.component ? `${t.component}: ${t.description.slice(0, 80)}` : t.description.slice(0, 80)),
      }, { ...(context.architecture?.sourceEvidence ? { source: context.architecture.sourceEvidence } : {}) })
    }

    const newTotal =
      (enrichment.dread.damage +
        enrichment.dread.reproducibility +
        enrichment.dread.exploitability +
        enrichment.dread.affectedUsers +
        enrichment.dread.discoverability) / 5

    const correctedDread = { ...enrichment.dread, total: Math.round(newTotal * 10) / 10 }

    const assessed = normalizeThreatScore({
      ...t,
      // Apply architectural pattern refactoring (guaranteed by schema)
      title: enrichment.title,
      description: t.description,
      // Apply DREAD corrections
      dread: correctedDread,
      scoringStatus: enrichment.scoringStatus ?? 'validated' as const,
      scoringRationale: enrichment.scoringRationale ?? enrichment.correctionReason ?? 'The scoring pass returned dimensions without a rationale.',
      priority: dreadToPriority(correctedDread.total),
      // Preserve the validated source references from synthesis; this stage does not regenerate them.
    })
    if (assessed.scoringStatus === 'unscored') {
      options.onBatchError?.(`DREAD could not assess ${t.id}; the finding remains explicitly unscored.`)
    }
    return applyCitationIntegrity(assessed, {
      ...(context.architecture?.sourceEvidence ? { source: context.architecture.sourceEvidence } : {}),
    })
  })
}
