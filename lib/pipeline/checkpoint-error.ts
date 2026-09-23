export class CheckpointWriteError extends Error {
  readonly code = 'CHECKPOINT_WRITE_FAILED'
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CheckpointWriteError'
  }
}
