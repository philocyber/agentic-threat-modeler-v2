import { probeChromaInventory } from '@/lib/health/rag-status'
import { getConfig } from '@/lib/config'
import { localAdministrationRoute, localRoute } from '@/lib/local-route'
import { getRAGIndexJob, startRAGIndexJob } from '@/lib/rag/index-job'
import { getRAGIndexReadiness, type RAGIndexReadiness } from '@/lib/rag/index-state'

export const runtime = 'nodejs'

async function getIndexOverview(): Promise<{ index: RAGIndexReadiness; job: ReturnType<typeof getRAGIndexJob> }> {
  const job = getRAGIndexJob()
  const { embeddingModel, knowledgeBasePath, chromaHost, chromaPort } = getConfig().rag
  const currentIndex = await getRAGIndexReadiness(embeddingModel, knowledgeBasePath)
  const snapshot = currentIndex.snapshot
  let { readiness } = currentIndex
  const { state } = currentIndex
  if (readiness.reason === 'up-to-date' && !state?.collections) {
    readiness = { ...readiness, needsReindex: snapshot.sourceCount > 0, reason: 'vector-index-incomplete' }
  }

  // Fingerprints describe source files, not the contents of the Docker volume.
  // A reset or replaced Chroma store must remain recoverable from Knowledge.
  const recoveredSinceFailure = Boolean(state && job.startedAt
    && Date.parse(state.indexedAt) >= Date.parse(job.startedAt))
  if (job.status === 'running' || (job.status === 'failed' && !recoveredSinceFailure)) {
    readiness = { ...readiness, needsReindex: snapshot.sourceCount > 0, reason: 'vector-index-incomplete' }
  } else if (readiness.reason === 'up-to-date') {
    const inventory = await probeChromaInventory(`http://${chromaHost}:${chromaPort}`, state?.collections)
    if (inventory.documentCount === null || inventory.documentCount === 0) {
      readiness = {
        ...readiness,
        needsReindex: snapshot.sourceCount > 0,
        reason: inventory.documentCount === 0 ? 'vector-index-empty' : 'vector-index-unavailable',
      }
    }
  }

  return { index: readiness, job }
}

export const GET = localRoute(async () => Response.json(await getIndexOverview()))

export const POST = localAdministrationRoute(async () => {
  const overview = await getIndexOverview()
  if (overview.job.status === 'running') {
    return Response.json({ ...overview, message: 'A knowledge reindex is already running.' }, { status: 409 })
  }
  if (!overview.index.needsReindex) {
    return Response.json({ ...overview, message: 'Knowledge index is already up to date. No rebuild was started.' }, { status: 409 })
  }
  const result = startRAGIndexJob()
  return Response.json({
    index: overview.index,
    job: result.job,
    message: result.started
      ? 'Knowledge reindex started.'
      : result.job.status === 'running'
        ? 'A knowledge reindex is already running.'
        : 'Knowledge reindex could not be started.',
  }, { status: result.started ? 202 : result.job.status === 'running' ? 409 : 500 })
})
