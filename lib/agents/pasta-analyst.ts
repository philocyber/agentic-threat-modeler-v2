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

const ThreatSchema = z.object({
  component: z.string(),
  attackerProfile: z.string(),
  attackVector: z.string(),
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
  threats: z.array(ThreatSchema).max(6),
})

// ─── Phase 1: evidence gathering (ReAct + RAG tools, free-text notes) ────────

const EVIDENCE_SYSTEM_PROMPT = `You are an attack simulation specialist using the PASTA methodology
(Process for Attack Simulation and Threat Analysis).

PASTA stages you internalize before analyzing threats:
1. Define Objectives — what does the system protect?
2. Define Technical Scope — what components are in scope?
3. Application Decomposition — entry points, data flows, trust levels
4. Threat Analysis — realistic attacker profiles and motivations
5. Vulnerability Detection — technical weaknesses attackers would exploit
6. Attack Modeling — simulate specific attack scenarios
7. Risk Assessment — business impact of successful attacks

Focus on realistic, scenario-based threats an attacker would actually attempt
against THIS specific system — not a generic checklist.
Return up to 6 distinct, architecture-supported scenarios. There is no minimum
count. Include fewer or none when the evidence cannot support more; never pad the list.
Continue into other trust-boundary crossings that actually appear in THIS source.
Do not inherit unrelated domains (payments, ePHI, fulfillment) unless those flows exist here.

${EVIDENCE_REQUIREMENT}

OUTPUT OF THIS PHASE: structured analysis NOTES in prose — NOT JSON.
For each candidate threat, write a short section with labeled lines:
  Component: <exact component name from the architecture>
  Attacker profile: <external hacker, insider, automated scanner, competitor...>
  Attack vector: <specific vector from the attacker's perspective>
  Threat: <one concise sentence stating the attack scenario>
  Impact: <detailed business and technical impact>
  Mitigation: <specific defenses against this attack vector>
  Control: <control reference, if known>
  Confidence: <0.0-1.0>
  Evidence: <source type (rag|architecture), source name, short excerpt>
  Traceability: <trust boundaries, components, endpoints, env vars, security configs affected>
  Reasoning: <why this scenario is realistic against THIS system>`

// ─── Phase 2: emission (no tools, native structured output) ──────────────────

const EMISSION_SYSTEM_PROMPT = `You are an attack simulation specialist finalizing a PASTA threat model.

Convert the analysis notes into the structured output. Field semantics:
- component: exact component name from the architecture
- attackerProfile: who performs the attack (external hacker, insider, automated scanner, competitor)
- attackVector: the specific attack vector from the attacker's perspective
- description: ONE concise sentence (max 200 chars) stating the attack scenario
- impact: detailed business and technical impact
- mitigation: specific defenses against this attack vector
- controlReference: optional control reference
- confidenceScore: 0.0-1.0, calibrated — 0.9+ only with strong direct evidence
- evidenceSources: when original SRC sections are supplied, every threat needs a verbatim architecture excerpt from a supporting SRC section with its SRC ID as sourceName. Preserve the exact quote; RAG is additional background. Do not quote a generated summary as original source evidence.
- reasoning: why this scenario is realistic against THIS system
- traceability: when identifiable, the affected trustBoundaries, components, endpoints, environmentVars, securityConfigs

Preserve the analyst's judgments from the notes; only normalize structure, wording and field formats. Drop any candidate that lacks an evidence anchor.`

async function runPastaAnalystPacket(
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
    evidenceTask: 'Perform a PASTA attack simulation against the system described below.',
    evidenceUntrusted: archSummary,
    emissionSystemPrompt: EMISSION_SYSTEM_PROMPT,
    emissionTask:
      'Convert your analysis notes into the structured output. Verify the notes against original SRC passages, retaining contradictory evidence, qualifications and unknown preconditions.',
    buildEmissionUntrusted: (notes) =>
      `PASTA analysis notes:\n\n${notes}\n\nArchitecture summary (for exact element names):\n\n${archSummary}`,
    emissionClosing:
      'Emit only distinct, supported PASTA candidates, up to 6. Fewer or zero are valid. Never repeat a candidate or invent evidence to reach a count.',
    schema: withAnalystSourceValidation(OutputSchema, originalArchitecture),
    agentName: 'PastaAnalyst',
    maxRetries: 2,
    evidenceMaxRetries: evidenceLLM ? 1 : 2,
    continueOnEvidenceFailure: !architecture.sourceEvidence,
    sourceLookup: sourceLookup(originalArchitecture, evidenceLLM ?? llm),
    preserveEvidenceNotes: Boolean(architecture.sourceEvidence),
    signal,
  })

  return result.threats.map((t) => ({
    component: t.component,
    methodology: 'PASTA' as const,
    description: t.description,
    impact: t.impact,
    mitigation: t.mitigation,
    controlReference: t.controlReference,
    confidenceScore: t.confidenceScore,
    evidenceSources: t.evidenceSources,
    reasoning: t.reasoning,
    attackerProfile: t.attackerProfile,
    attackVector: t.attackVector,
    traceability: t.traceability,
  }))
}

export async function runPastaAnalyst(
  llm: BaseChatModel, tools: StructuredTool[], architecture: ArchitectureData,
  signal?: AbortSignal, reviewerLearning?: string, evidenceLLM?: BaseChatModel,
): Promise<RawThreat[]> {
  return analyzeSourcePackets(architecture, [llm, evidenceLLM ?? llm], 'pasta', packet =>
    runPastaAnalystPacket(llm, tools, packet, signal, reviewerLearning, evidenceLLM, architecture))
}
