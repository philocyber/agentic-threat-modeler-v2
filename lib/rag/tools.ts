import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { CorporateRAGStore } from './corporate-store'
import type { RAGTraceCollector } from './trace'
import { DualRAGRouter, type RAGProfile } from './router'
import type { RAGStoreManager } from './store'
import { registerToolEvidence } from './evidence'

const QuerySchema = z.object({
  system: z.string().max(240).optional(),
  environment: z.string().max(120).optional(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  purpose: z.enum(['mechanism', 'control', 'impact', 'verification']).optional(),
  query: z.string().min(1).max(1000).describe('The concrete security question this pipeline step needs answered'),
  facets: z.array(z.string().min(1).max(240)).max(8).optional().describe(
    'Specific components, flows, controls, attack paths, or threat IDs that the evidence must address',
  ),
})

function createProfileTool(
  router: DualRAGRouter,
  profile: RAGProfile,
  name: string,
  description: string,
) {
  const result = tool(
    async (request: z.infer<typeof QuerySchema>) =>
      JSON.stringify(await router.queryPack(request, profile)),
    { name, description, schema: QuerySchema },
  )
  registerToolEvidence(result, () => router.getPassages())
  return result
}

/**
 * Creates role-specific retrieval tools over two deliberately separate domains:
 * tool-wide technical and corporate knowledge. Human
 * review decisions are fetched from the active workspace as a third evidence
 * channel and are never written to the global technical corpus.
 */
export function createRAGTools(
  technical: RAGStoreManager,
  corporate: CorporateRAGStore | null,
  trace?: RAGTraceCollector,
  knowledgeBasePath?: string,
  systemId?: string | null,
  currentRunId?: string,
) {
  const router = new DualRAGRouter(technical, corporate, trace, knowledgeBasePath, systemId, currentRunId)
  const analyst = createProfileTool(
    router,
    'analyst',
    'rag_query_analysis_evidence',
    'Retrieve balanced technical, corporate, and human-reviewed evidence for threat discovery. Results contain stable RAG citation IDs and exact passages with source metadata.',
  )
  const redTeam = createProfileTool(
    router,
    'red_team',
    'rag_query_red_team_evidence',
    'Retrieve evidence weighted toward attack techniques and technical threat patterns while preserving project context.',
  )
  const blueTeam = createProfileTool(
    router,
    'blue_team',
    'rag_query_blue_team_evidence',
    'Retrieve evidence weighted toward project controls, architecture constraints, and prior reviewer decisions.',
  )
  const synthesis = createProfileTool(
    router,
    'synthesis',
    'rag_query_synthesis_evidence',
    'Retrieve project-specific and reviewed evidence for final threat synthesis, backed by global technical references.',
  )
  const validator = createProfileTool(
    router,
    'validator',
    'rag_query_validation_evidence',
    'Retrieve technical and project evidence used to validate risk scoring and traceability.',
  )

  return {
    router,
    analyst,
    redTeam,
    blueTeam,
    synthesis,
    validator,
    STRIDE_TOOLS: [analyst],
    PASTA_TOOLS: [analyst],
    ATTACK_TREE_TOOLS: [analyst],
    RED_TEAM_TOOLS: [redTeam],
    BLUE_TEAM_TOOLS: [blueTeam],
    SYNTHESIS_TOOLS: [synthesis],
    VALIDATOR_TOOLS: [validator],
  }
}

export type RAGToolset = ReturnType<typeof createRAGTools>

/** Same shape as live tools, with no retrieval — used when RAG is off or Chroma is down. */
export function createIdleRAGTools(): RAGToolset {
  const router = { setPlan: () => undefined, getPassages: () => [] } as unknown as RAGToolset['router']
  const unused = undefined as unknown as RAGToolset['analyst']
  return {
    router,
    analyst: unused,
    redTeam: unused,
    blueTeam: unused,
    synthesis: unused,
    validator: unused,
    STRIDE_TOOLS: [],
    PASTA_TOOLS: [],
    ATTACK_TREE_TOOLS: [],
    RED_TEAM_TOOLS: [],
    BLUE_TEAM_TOOLS: [],
    SYNTHESIS_TOOLS: [],
    VALIDATOR_TOOLS: [],
  }
}
