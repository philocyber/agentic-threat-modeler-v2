export type RunExecutionKind = 'completed' | 'partial' | 'failed' | 'pending' | 'running' | 'unknown'

export type ExecutionStatus = {
  kind: RunExecutionKind
  headline: string
  detail: string
  findingCount: number
}

export function describeRunExecution(params: {
  status?: string | null | undefined
  errorMessage?: string | null | undefined
  pipelineErrors?: string[] | null | undefined
  threatCount: number
}): ExecutionStatus {
  const errors = params.pipelineErrors?.filter(Boolean) ?? []
  if (params.status === 'pending' || params.status === 'running') {
    return {
      kind: params.status,
      headline: params.status === 'pending' ? 'Analysis queued' : 'Analysis in progress',
      detail: 'This review has not finished. Any findings shown are provisional; an empty list is not a conclusion of zero threats.',
      findingCount: params.threatCount,
    }
  }
  const failed = params.status === 'failed' || Boolean(params.errorMessage && params.status !== 'partial' && params.status !== 'completed')
  const partial = params.status === 'partial' || (!failed && errors.length > 0)
  if (failed) {
    return {
      kind: 'failed',
      headline: 'Analysis failed',
      detail: params.errorMessage
        ?? (params.threatCount === 0
          ? 'The pipeline stopped before a complete review. This is not a conclusion of zero threats. No findings were produced because execution failed.'
          : `The pipeline stopped before a complete review. Preserved ${params.threatCount} incomplete finding(s).`),
      findingCount: params.threatCount,
    }
  }
  if (partial) {
    return {
      kind: 'partial',
      headline: 'Analysis ended partially',
      detail: `${errors[0] ?? 'One or more stages degraded.'} Completed work is preserved; missing stages are not equivalent to an empty threat model.`,
      findingCount: params.threatCount,
    }
  }
  if (params.status !== 'completed') {
    return {
      kind: 'unknown',
      headline: 'Execution status unavailable',
      detail: 'Completion could not be verified. This report cannot establish that all required stages finished or that no threats were found.',
      findingCount: params.threatCount,
    }
  }
  if (params.threatCount === 0) {
    return {
      kind: 'completed',
      headline: 'Completed with no architecture-supported threats',
      detail: 'The pipeline finished every required stage and did not emit an architecture-supported candidate. That is a legitimate empty result, not a failed run.',
      findingCount: 0,
    }
  }
  return {
    kind: 'completed',
    headline: `Completed with ${params.threatCount} finding(s)`,
    detail: `Analysis identified ${params.threatCount} architecture-supported finding(s).`,
    findingCount: params.threatCount,
  }
}

export function isLegitimateZeroFindings(status: ExecutionStatus): boolean {
  return status.kind === 'completed' && status.findingCount === 0
}
