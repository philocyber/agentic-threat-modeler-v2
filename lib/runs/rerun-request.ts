import type { AnalysisConfig } from '@/lib/models/types'
import type { RunInputBundle } from '@/lib/runs/input-bundle'

export type RerunMode = 'fresh' | 'resume'

export type RerunRequest = {
  systemName: string
  systemId?: string
  input: string
  inputType: RunInputBundle['inputType']
  config?: AnalysisConfig
  resumeFrom?: string
}

/**
 * Rebuild an analysis request from the immutable input bundle stored with a
 * run. A resume keeps checkpoint lineage; a fresh rerun intentionally omits it
 * so every phase executes again.
 */
export function buildRerunRequest(bundle: RunInputBundle, mode: RerunMode): RerunRequest {
  return {
    systemName: bundle.systemName,
    input: bundle.effectiveInput,
    inputType: bundle.inputType,
    ...(bundle.systemId ? { systemId: bundle.systemId } : {}),
    ...(bundle.executionConfig ? { config: bundle.executionConfig } : {}),
    ...(mode === 'resume' ? { resumeFrom: bundle.runId } : {}),
  }
}
