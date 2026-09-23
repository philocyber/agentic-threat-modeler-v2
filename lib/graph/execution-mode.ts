import type { AnalysisConfig } from '@/lib/db/schema'

type EdgeGraph = { addEdge(from: string | string[], to: string): void }

/**
 * parallel — all analysts after architecture (max concurrency)
 * cascade — stride → pasta → attack_tree (sequential)
 * hybrid — stride first, then pasta ∥ attack_tree
 */
export function wireAnalystEdges(
  g: EdgeGraph,
  mode: AnalysisConfig['executionMode'],
): void {
  if (mode === 'cascade') {
    g.addEdge('architecture_parser', 'stride_analyst')
    g.addEdge('stride_analyst', 'pasta_analyst')
    g.addEdge('pasta_analyst', 'attack_tree_analyst')
    g.addEdge('attack_tree_analyst', 'pre_dedup')
    return
  }

  if (mode === 'hybrid') {
    g.addEdge('architecture_parser', 'stride_analyst')
    g.addEdge('stride_analyst', 'pasta_analyst')
    g.addEdge('stride_analyst', 'attack_tree_analyst')
    // An array of start nodes is a LangGraph barrier: pre_dedup runs once,
    // only after both parallel branches have reached a terminal result.
    g.addEdge(['pasta_analyst', 'attack_tree_analyst'], 'pre_dedup')
    return
  }

  // parallel (default fan-out)
  g.addEdge('architecture_parser', 'stride_analyst')
  g.addEdge('architecture_parser', 'pasta_analyst')
  g.addEdge('architecture_parser', 'attack_tree_analyst')
  // Separate analyst -> pre_dedup edges trigger pre_dedup independently.
  // The multi-source edge is the explicit wait-for-all join.
  g.addEdge(['stride_analyst', 'pasta_analyst', 'attack_tree_analyst'], 'pre_dedup')
}
