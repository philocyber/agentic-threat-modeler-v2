export class PipelineLeaseLostError extends Error {
  readonly code = 'PIPELINE_LEASE_LOST'
  constructor(message = 'Lost pipeline lease') {
    super(message)
    this.name = 'PipelineLeaseLostError'
  }
}

export function leaseLostError(): PipelineLeaseLostError {
  return new PipelineLeaseLostError()
}

export function isPipelineLeaseLost(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: string; code?: string }
  return candidate.name === 'PipelineLeaseLostError' || candidate.code === 'PIPELINE_LEASE_LOST'
}
