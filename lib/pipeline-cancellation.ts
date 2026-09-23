import {
  claimThreatModelRun,
  claimNextThreatModelRun,
  isThreatModelCancellationRequested,
  reapStaleThreatModelHeartbeats,
  touchThreatModelHeartbeat,
} from '@/lib/storage/threat-models'
import { createWorkerInstanceId } from '@/lib/pipeline/worker-id'
import { abortPipelineJob } from '@/lib/pipeline-jobs'
import { leaseLostError } from '@/lib/pipeline/lease-error'
import { PIPELINE_LEASE_TTL_MS } from '@/lib/pipeline/lease'

export { isPipelineLeaseLost, leaseLostError } from '@/lib/pipeline/lease-error'

let workerInstanceId: string | null = null

export function setPipelineWorkerInstanceId(id: string): void {
  workerInstanceId = id
}

export function getPipelineWorkerInstanceId(): string {
  workerInstanceId ??= createWorkerInstanceId()
  return workerInstanceId
}

function cancellationError(): Error {
  const error = new Error('Stopped by user')
  error.name = 'AbortError'
  return error
}

export async function claimPipelineRun(analysisId: string): Promise<boolean> {
  return claimThreatModelRun(analysisId, getPipelineWorkerInstanceId())
}

export async function claimNextPipelineRun(): Promise<string | null> {
  return claimNextThreatModelRun(getPipelineWorkerInstanceId())
}

export async function isPipelineCancellationRequested(analysisId: string): Promise<boolean> {
  return isThreatModelCancellationRequested(analysisId)
}

/** Synchronize durable Stop requests even when they reached another process. */
export async function syncPipelineCancellation(analysisId: string): Promise<void> {
  if (await isPipelineCancellationRequested(analysisId)) {
    abortPipelineJob(analysisId, cancellationError())
  }
}

export async function assertPipelineNotCancelled(analysisId: string): Promise<void> {
  if (await isPipelineCancellationRequested(analysisId)) throw cancellationError()
}

export async function reapStaleHeartbeats(
  staleMs = PIPELINE_LEASE_TTL_MS,
): Promise<Array<{ id: string; title: string | null }>> {
  return reapStaleThreatModelHeartbeats(staleMs)
}

export async function touchPipelineHeartbeat(
  analysisId: string,
  currentPhase?: string,
): Promise<boolean> {
  const renewed = await touchThreatModelHeartbeat(
    analysisId,
    getPipelineWorkerInstanceId(),
    currentPhase,
  )
  if (!renewed) abortPipelineJob(analysisId, leaseLostError())
  return renewed
}

export async function assertOwnsPipelineLease(analysisId: string, currentPhase?: string): Promise<void> {
  const renewed = await touchPipelineHeartbeat(analysisId, currentPhase)
  if (!renewed) throw leaseLostError()
}
