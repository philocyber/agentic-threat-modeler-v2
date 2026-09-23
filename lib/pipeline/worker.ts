import { getConfig } from '@/lib/config'
import { logger } from '@/lib/logger'
import { claimNextPipelineRun, reapStaleHeartbeats, setPipelineWorkerInstanceId } from '@/lib/pipeline-cancellation'
import { executePipelineRun } from '@/lib/pipeline/execute-run'
import { PIPELINE_LEASE_TTL_MS, PIPELINE_WORKER_POLL_MS } from '@/lib/pipeline/lease'
import { createWorkerInstanceId } from '@/lib/pipeline/worker-id'
import { recordWorkerLiveness } from '@/lib/pipeline/worker-liveness'
import { listLocalProjects } from '@/lib/workspace/local-project'
import { runWithWorkspace } from '@/lib/workspace/context'

let projectCursor = 0

export async function startPipelineWorker(): Promise<void> {
  const workerId = createWorkerInstanceId()
  setPipelineWorkerInstanceId(workerId)
  getConfig()
  logger.info('Pipeline worker started', { workerInstanceId: workerId })
  await recordWorkerLiveness(workerId)

  let stopping = false
  let running: Promise<void> | null = null
  const stop = () => {
    stopping = true
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  while (!stopping) {
    try {
      running = pollOnce()
      await running
      running = null
    } catch (err) {
      logger.error('Pipeline worker poll failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    await recordWorkerLiveness(workerId)
    if (!stopping) await sleep(PIPELINE_WORKER_POLL_MS)
  }
  if (running) await running
  logger.info('Pipeline worker stopped', { workerInstanceId: workerId })
}

async function pollOnce(): Promise<void> {
  if (process.env.DATABASE_URL) {
    await reapStaleHeartbeats(PIPELINE_LEASE_TTL_MS)
    const claimed = await claimNextPipelineRun()
    if (claimed) await executePipelineRun(claimed)
    return
  }

  const projects = await listLocalProjects()
  if (projects.length === 0) return
  const start = projectCursor % projects.length
  const ordered = [...projects.slice(start), ...projects.slice(0, start)]
  for (const [offset, project] of ordered.entries()) {
    const claimed = await runWithWorkspace(project, async () => {
      await reapStaleHeartbeats(PIPELINE_LEASE_TTL_MS)
      return claimNextPipelineRun()
    })
    if (claimed) {
      projectCursor = (start + offset + 1) % projects.length
      await runWithWorkspace(project, () => executePipelineRun(claimed))
      return
    }
  }
  projectCursor = (start + 1) % projects.length
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
