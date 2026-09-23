import { analyzeSourcePackets } from './source-analysis'
import { withAnalystSourceValidation } from './analyst-source-schema'
import { sourceLookup } from '@/lib/architecture/source-evidence'
import { z } from 'zod'
import { invokeAgentTwoPhase, EVIDENCE_REQUIREMENT } from './base'
import { buildArchSummary } from './shared'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredTool } from '@langchain/core/tools'
import type { ArchitectureData, RawThreat } from '@/lib/models/types'
import { TraceabilitySchema } from '@/lib/models/schemas'

const StrideCategories = z.enum([
  'Spoofing',
  'Tampering',
  'Repudiation',
  'Information Disclosure',
  'Denial of Service',
  'Elevation of Privilege',
])

const ThreatSchema = z.object({
  component: z.string(),
  strideCategory: StrideCategories,
  description: z.string().min(50).transform(val => val.slice(0, 500)),  // Soft limit 200 chars (prompt), hard limit 500 (truncate)
  impact: z.string(),
  mitigation: z.string(),
  controlReference: z.string().nullable().optional(),
  confidenceScore: z.number().min(0).max(1),
  evidenceSources: z.array(
    z.object({
      sourceType: z.enum(['rag', 'architecture']),
      sourceName: z.string(),
      excerpt: z.string(),
    })
  ),
  reasoning: z.string().nullable().optional(),
  traceability: TraceabilitySchema.optional(),
})

const OutputSchema = z.object({
  threats: z.array(ThreatSchema).max(10),
})

// ─── Phase 1: evidence gathering (ReAct + RAG tools, free-text notes) ────────

export const EVIDENCE_SYSTEM_PROMPT = `You are a senior application security engineer conducting a STRIDE threat model.

STRIDE categories:
- Spoofing: Impersonating something or someone else
- Tampering: Modifying data or code
- Repudiation: Claiming to not have performed an action
- Information Disclosure: Exposing information to unauthorized parties
- Denial of Service: Denying or degrading service to valid users
- Elevation of Privilege: Gaining capabilities without proper authorization

METHODOLOGY — work in this order, it is what makes the coverage defensible:
1. Enumerate the data flows that CROSS a trust boundary, plus every externally
   reachable entry point. These carry the real risk; start there.
2. Then the components that hold or process the valuable data stores.
3. Then anything left over.
For each element you examine, walk the six categories deliberately rather than
reporting the first one that comes to mind.
4. Use the retrieved knowledge-base passages already in context to validate and enrich threats (OWASP, CWE, MITRE). Do not stall waiting to call a retrieval tool.
5. Only keep threats you can anchor to a specific component AND have either architectural or RAG evidence

COVERAGE DISCIPLINE:
- Do not let one category dominate: if more than half your candidates share a
  single STRIDE category, you skipped the analysis for the others — go back.
- A category with no credible threat for this system is a finding too. Note it
  once as "Coverage: <category> — not applicable because <reason>" instead of
  inventing something to fill the slot.
- Two threats on the same component in the same category must describe different
  attacker paths, or they are one threat.
- Fact-ledger "open items" are seeds, not the model. After covering them, keep
  walking other trust-boundary crossings that actually appear in THIS
  architecture. Stopping at two components is incomplete. Do not inherit
  unrelated domains (payments, ePHI, fulfillment) unless the source names them.

Return up to 10 distinct candidate threats. There is no minimum count. Include
fewer or none when original evidence cannot support more; never repeat a candidate
or invent a weakness to fill a STRIDE category.

${EVIDENCE_REQUIREMENT}

OUTPUT OF THIS PHASE: structured analysis NOTES in prose — NOT JSON.
For each candidate threat, write a short section with labeled lines:
  Component: <exact component name from the architecture>
  STRIDE: <category>
  Threat: <one concise sentence stating the vulnerability>
  Impact: <what harm results if exploited>
  Mitigation: <specific, actionable remediation steps>
  Control: <control reference, if known>
  Confidence: <0.0-1.0>
  Evidence: <source type (rag|architecture), source name, short excerpt>
  Traceability: <trust boundaries, components, endpoints, env vars, security configs affected>
  Reasoning: <why this threat applies to THIS system>

Write for a developer audience — avoid generic security jargon.`

// ─── Phase 2: emission (no tools, native structured output) ──────────────────

export const EMISSION_SYSTEM_PROMPT = `You are a senior application security engineer finalizing a STRIDE threat model.

Convert the analysis notes into the structured output. Field semantics:
- component: exact component name from the architecture
- strideCategory: one of Spoofing | Tampering | Repudiation | Information Disclosure | Denial of Service | Elevation of Privilege
- description: ONE concise sentence (max 200 chars) stating the vulnerability. Example: "The API endpoint /users/:id lacks authorization checks, allowing IDOR attacks."
- impact: detailed explanation of WHAT harm results if exploited
- mitigation: specific, actionable remediation steps
- controlReference: optional control reference (e.g. "NIST 800-53 IA-2")
- confidenceScore: 0.0-1.0, calibrated — 0.9+ only with strong direct evidence
- evidenceSources: when original SRC sections are supplied, every threat needs a verbatim architecture excerpt from a supporting SRC section with its SRC ID as sourceName. Preserve the exact quote; RAG is additional background. Do not quote a generated summary as original source evidence.
- reasoning: why this threat applies to THIS system
- traceability: when identifiable, the affected trustBoundaries, components, endpoints, environmentVars, securityConfigs

Preserve the analyst's judgments from the notes; only normalize structure, wording and field formats. Drop any candidate that lacks an evidence anchor.
"Coverage:" lines in the notes are analysis bookkeeping, not threats — never emit them as threats.`

async function runStrideAnalystPacket(
  llm: BaseChatModel,
  tools: StructuredTool[],
  architecture: ArchitectureData,
  signal?: AbortSignal | undefined,
  reviewerLearning?: string,
  evidenceLLM?: BaseChatModel,
  originalArchitecture: ArchitectureData = architecture,
): Promise<RawThreat[]> {
  const archSummary = buildArchSummary(architecture)
  const evidenceSystemPrompt = reviewerLearning
    ? `${EVIDENCE_SYSTEM_PROMPT}\n\n${reviewerLearning}`
    : EVIDENCE_SYSTEM_PROMPT

  const result = await invokeAgentTwoPhase({
    llm,
    evidenceLLM,
    tools,
    evidenceSystemPrompt,
    evidenceTask: 'Perform a STRIDE analysis of the system described below.',
    evidenceUntrusted: archSummary,
    emissionSystemPrompt: EMISSION_SYSTEM_PROMPT,
    emissionTask:
      'Convert your analysis notes into the structured output. Verify the notes against original SRC passages, retaining contradictory evidence, qualifications and unknown preconditions.',
    buildEmissionUntrusted: (notes) =>
      `STRIDE analysis notes:\n\n${notes}\n\nArchitecture summary (for exact element names):\n\n${archSummary}`,
    emissionClosing:
      'Emit only distinct, supported STRIDE candidates, up to 10. Fewer or zero are valid. Never repeat a candidate or invent evidence to reach a count.',
    schema: withAnalystSourceValidation(OutputSchema, originalArchitecture),
    agentName: 'StrideAnalyst',
    maxRetries: 2,
    evidenceMaxRetries: evidenceLLM ? 1 : 2,
    continueOnEvidenceFailure: !architecture.sourceEvidence,
    sourceLookup: sourceLookup(originalArchitecture, evidenceLLM ?? llm),
    preserveEvidenceNotes: Boolean(architecture.sourceEvidence),
    signal,
  })

  return result.threats.map((t) => ({ ...t, methodology: 'STRIDE' as const }))
}

export async function runStrideAnalyst(
  llm: BaseChatModel, tools: StructuredTool[], architecture: ArchitectureData,
  signal?: AbortSignal, reviewerLearning?: string, evidenceLLM?: BaseChatModel,
): Promise<RawThreat[]> {
  return analyzeSourcePackets(architecture, [llm, evidenceLLM ?? llm], 'stride', packet =>
    runStrideAnalystPacket(llm, tools, packet, signal, reviewerLearning, evidenceLLM, architecture))
}
