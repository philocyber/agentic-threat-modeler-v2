/**
 * In-process job registry for abortable pipeline runs.
 * Complements DB status: Stop aborts the AbortController so LLM work can be cancelled.
 */

// Route bundles and development reloads must reach the same controllers as
// the background jobs they stop. Module-local maps split that ownership.
const processState = globalThis as typeof globalThis & {
  __agenticTmPipelineControllers?: Map<string, AbortController>
}
const controllers = processState.__agenticTmPipelineControllers ??= new Map<string, AbortController>()

export function registerPipelineJob(analysisId: string): AbortSignal {
  // Replace any stale controller for the same id
  const existing = controllers.get(analysisId)
  if (existing) existing.abort()

  const controller = new AbortController()
  controllers.set(analysisId, controller)
  return controller.signal
}

export function abortPipelineJob(analysisId: string, reason?: unknown): boolean {
  const controller = controllers.get(analysisId)
  if (!controller) return false
  controller.abort(reason)
  controllers.delete(analysisId)
  return true
}

export function clearPipelineJob(analysisId: string): void {
  controllers.delete(analysisId)
}
