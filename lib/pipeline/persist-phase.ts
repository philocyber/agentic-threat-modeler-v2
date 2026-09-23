import { appendPipelineError, saveArchitectureCheckpoint } from '@/lib/storage/threat-models'
import { recordPhaseOutput } from '@/lib/workspace/run-artifacts'
import type { PhaseOutput } from '@/lib/graph/builder'
import type { RAGTraceCollector } from '@/lib/rag/trace'

export async function persistPhaseOutput(
  threatModelId: string,
  output: PhaseOutput,
  ragTrace: RAGTraceCollector,
): Promise<void> {
  await recordPhaseOutput(threatModelId, `rag_evidence_${output.phase}`, ragTrace.snapshot())
  if ('degraded' in output) {
    await appendPipelineError(threatModelId, output.error)
    await recordPhaseOutput(threatModelId, `${output.phase}.degraded`, { error: output.error })
    return
  }
  if ('architecture' in output) {
    await saveArchitectureCheckpoint(threatModelId, output.architecture)
    await recordPhaseOutput(threatModelId, output.phase, output.architecture)
    return
  }
  if ('threats' in output) {
    await recordPhaseOutput(threatModelId, output.phase, {
      threats: output.threats,
      sourceDelivery: output.sourceDelivery,
    })
    return
  }
  if ('threatsKept' in output) {
    await recordPhaseOutput(threatModelId, output.phase, {
      threatsKept: output.threatsKept,
      filteredCount: output.filteredCount,
    })
    return
  }
  if ('debateRounds' in output) {
    await recordPhaseOutput(threatModelId, output.phase, {
      rounds: output.debateRounds,
      complete: output.complete ?? true,
    })
    return
  }
  if ('threatsPreDedup' in output) {
    await recordPhaseOutput(threatModelId, output.phase, output.threatsPreDedup)
    return
  }
  if ('scope' in output) {
    await recordPhaseOutput(threatModelId, output.phase, output.scope)
    return
  }
  if ('evidence' in output) {
    await recordPhaseOutput(threatModelId, output.phase, output.evidence)
    return
  }
  if ('candidates' in output) {
    await recordPhaseOutput(threatModelId, output.phase, output.candidates)
    return
  }
  await recordPhaseOutput(threatModelId, output.phase, {
    threatsFinal: output.threatsFinal,
    filteredCount: output.filteredCount,
  })
}
