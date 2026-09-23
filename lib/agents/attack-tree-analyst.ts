import { analyzeSourcePackets } from './source-analysis'
import { withAnalystSourceValidation } from './analyst-source-schema'
import { sourceLookup } from '@/lib/architecture/source-evidence'
import { z } from 'zod'
import { invokeAgentTwoPhase, EVIDENCE_REQUIREMENT } from './base'
import { buildArchSummary } from './shared'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredTool } from '@langchain/core/tools'
import type { ArchitectureData, RawThreat } from '@/lib/models/types'
import { withRenderedAttackTree } from './attack-tree-render'
import { AttackTreeSchema, TraceabilitySchema } from '@/lib/models/schemas'

const ThreatSchema = z.object({
  component: z.string().max(200),
  attackTree: AttackTreeSchema,
  description: z.string().min(50).max(500),
  impact: z.string().max(1_000),
  mitigation: z.string().max(1_500),
  controlReference: z.string().max(300).nullable().optional(),
  confidenceScore: z.number().min(0).max(1),
  evidenceSources: z.array(
    z.object({
      sourceType: z.enum(['rag', 'architecture']),
      sourceName: z.string().max(240),
      excerpt: z.string().max(800),
    })
  ).max(5),
  traceability: TraceabilitySchema.optional(),
})

const OutputSchema = z.object({
  threats: z.array(ThreatSchema).max(3),
})

// ─── Phase 1: evidence gathering (ReAct + RAG tools, free-text notes) ────────

const EVIDENCE_SYSTEM_PROMPT = `You are a red team specialist building attack trees to model complex attack paths.

Attack tree methodology:
- ROOT: The ultimate attack goal (e.g., "Exfiltrate customer PII")
- OR nodes: ANY one child achieves the goal (alternative paths)
- AND nodes: ALL children required (prerequisite chain)
- LEAF nodes: Atomic attack actions (no further decomposition)

Build attack trees for the most impactful attack goals against this system.
Focus on multi-step attacks that chain vulnerabilities together.
Each tree should represent a realistic kill chain, not a single-step attack.

Return up to 3 distinct, architecture-supported trees. There is no minimum count.
Include fewer or none when the evidence cannot support more; never pad the list.

${EVIDENCE_REQUIREMENT}

OUTPUT OF THIS PHASE: structured analysis NOTES in prose — NOT JSON.
For each candidate attack tree, write a short section:
  Component: <exact component name from the architecture>
  Root goal: <the ultimate attack goal>
  Tree sketch: <structured nodes only — ROOT/OR/AND/LEAF goals, no ASCII drawing>
  Threat: <one concise sentence summarizing the attack path>
  Impact: <what harm results if the goal is achieved>
  Mitigation: <specific steps that break the kill chain>
  Control: <control reference, if known>
  Confidence: <0.0-1.0>
  Evidence: <source type (rag|architecture), source name, short excerpt>
  Traceability: <trust boundaries, components, endpoints, env vars, security configs affected>`

// ─── Phase 2: emission (no tools, native structured output) ──────────────────

const EMISSION_SYSTEM_PROMPT = `You are a red team specialist finalizing attack trees for a threat model.

Convert the analysis notes into the structured output. Field semantics:
- component: exact component name from the architecture
- attackTree: the attack tree from the notes
  - rootGoal: the ultimate attack goal
  - tree: exactly one OR/AND root with 1-3 OR/AND path children; each path has 1-3 LEAF children
  - a LEAF is an atomic step and never has children; keep the whole tree at 13 nodes or fewer
  Do not emit textRepresentation or ASCII drawings; the backend renders the tree from nodes.
- description: ONE concise sentence (max 200 chars) summarizing the attack path
- impact: what harm results if the goal is achieved
- mitigation: specific steps that break the kill chain
- controlReference: optional control reference
- confidenceScore: 0.0-1.0, calibrated — 0.9+ only with strong direct evidence
- evidenceSources: cite catalog passage identifiers (SRC-… / RAG-…). Do not reproduce long quotations.
- traceability: when identifiable, the affected trustBoundaries, components, endpoints, environmentVars, securityConfigs

Preserve the tree structure from the notes faithfully; only normalize formats. Drop any candidate that lacks an evidence anchor.`

async function runAttackTreeAnalystPacket(
  llm: BaseChatModel,
  tools: StructuredTool[],
  architecture: ArchitectureData,
  signal?: AbortSignal | undefined,
  reviewerLearning?: string,
  evidenceLLM?: BaseChatModel,
  originalArchitecture: ArchitectureData = architecture,
): Promise<RawThreat[]> {
  const archSummary = buildArchSummary(architecture)
  const highValueAssets = [
    ...architecture.dataStores,
    ...architecture.externalEntities,
    ...architecture.apiEndpoints.slice(0, 5),
  ].join(', ')

  const evidenceSystemPrompt = reviewerLearning
    ? `${EVIDENCE_SYSTEM_PROMPT}\n\n${reviewerLearning}`
    : EVIDENCE_SYSTEM_PROMPT

  const result = await invokeAgentTwoPhase({
    llm,
    evidenceLLM,
    tools,
    evidenceSystemPrompt,
    evidenceTask: 'Build attack trees against the system described below.',
    evidenceUntrusted: `${archSummary}\nHigh-value assets: ${highValueAssets}`,
    emissionSystemPrompt: EMISSION_SYSTEM_PROMPT,
    emissionTask:
      'Convert your analysis notes into the structured output. Verify the notes against original SRC passages, retaining contradictory evidence, qualifications and unknown preconditions.',
    buildEmissionUntrusted: (notes) =>
      `Attack tree analysis notes:\n\n${notes}\n\nArchitecture summary (for exact element names):\n\n${archSummary}\nHigh-value assets: ${highValueAssets}`,
    emissionClosing:
      'Emit only distinct, supported candidates, up to 3. Fewer or zero are valid. Never repeat a candidate or invent evidence to reach a count.',
    schema: withAnalystSourceValidation(OutputSchema, originalArchitecture),
    agentName: 'AttackTreeAnalyst',
    maxRetries: 2,
    evidenceMaxRetries: evidenceLLM ? 1 : 2,
    continueOnEvidenceFailure: !architecture.sourceEvidence,
    sourceLookup: sourceLookup(originalArchitecture, evidenceLLM ?? llm),
    preserveEvidenceNotes: Boolean(architecture.sourceEvidence),
    signal,
  })

  return result.threats.map((t) => ({
    component: t.component,
    methodology: 'ATTACK_TREE' as const,
    description: t.description,
    impact: t.impact,
    mitigation: t.mitigation,
    controlReference: t.controlReference,
    confidenceScore: t.confidenceScore,
    evidenceSources: t.evidenceSources,
    attackTree: withRenderedAttackTree(t.attackTree),
    traceability: t.traceability,
  }))
}

export async function runAttackTreeAnalyst(
  llm: BaseChatModel, tools: StructuredTool[], architecture: ArchitectureData,
  signal?: AbortSignal, reviewerLearning?: string, evidenceLLM?: BaseChatModel,
): Promise<RawThreat[]> {
  return analyzeSourcePackets(architecture, [llm, evidenceLLM ?? llm], 'attack_tree', packet =>
    runAttackTreeAnalystPacket(llm, tools, packet, signal, reviewerLearning, evidenceLLM, architecture))
}
