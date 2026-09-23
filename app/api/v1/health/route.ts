import { probeOllamaModels } from '@/lib/health/ollama-models'
import { getConfig } from '@/lib/config'
import type { HealthStatus } from '@/lib/models/types'
import { probeRagHealth } from '@/lib/health/rag-status'
import { readWorkerLiveness } from '@/lib/pipeline/worker-liveness'
import { workerCompatibility } from '@/lib/pipeline/worker-version'
import { sql } from 'drizzle-orm'
import { localRoute } from '@/lib/local-route'

/** Deep health — probes dependencies available in the current deployment mode. */
export const GET = localRoute(async () => {
  const config = getConfig()
  const workerLiveness = await readWorkerLiveness()
  const workerCompat = workerCompatibility(workerLiveness)
  const services: HealthStatus['services'] = {
    database: 'not_configured',
    ollama: 'not_configured',
    chromadb: 'not_configured',
    gemini: 'not_configured',
    kimi: 'not_configured',
    bedrock: 'not_configured',
    cursor: 'not_configured',
    worker: workerLiveness.status,
  }

  if (process.env.DATABASE_URL) {
    try {
      const { db } = await import('@/lib/db')
      await db.execute(sql`SELECT 1`)
      services.database = 'up'
    } catch {
      services.database = 'down'
    }
  } else {
    services.database = 'up'
  }

  const ollamaModels = config.llm.provider === 'ollama'
    ? { ...await probeOllamaModels(config.llm.ollamaBaseUrl, [config.llm.ollamaQuickModel, config.llm.ollamaDeepModel]), quickModel: config.llm.ollamaQuickModel, deepModel: config.llm.ollamaDeepModel }
    : undefined
  if (ollamaModels) services.ollama = ollamaModels.reachable ? 'up' : 'down'

  const rag = await probeRagHealth({ ...config.rag, ollamaBaseUrl: config.llm.ollamaBaseUrl })
  const ragDefaultEnabled = process.env.RAG_DEFAULT_ENABLED !== 'false'
  services.chromadb = rag.status

  if (config.llm.provider === 'google' || config.llm.googleApiKey) {
    services.gemini = config.llm.googleApiKey ? 'up' : 'down'
  }

  if (config.llm.provider === 'kimi' || config.llm.kimiApiKey) {
    services.kimi = config.llm.kimiApiKey ? 'up' : 'down'
  }

  if (config.llm.provider === 'bedrock') {
    services.bedrock = config.llm.bedrockRegion ? 'up' : 'down'
  } else if (config.llm.bedrockAccessKeyId || config.llm.bedrockRegion) {
    services.bedrock = 'up'
  }

  if (config.llm.provider === 'cursor' || config.llm.cursorApiKey) {
    services.cursor = config.llm.cursorApiKey ? 'up' : 'down'
  }

  const overallStatus: HealthStatus['status'] =
    services.database === 'down'
      ? 'error'
      : (ollamaModels && !ollamaModels.ready) || (ragDefaultEnabled && (!rag.usable || rag.warning)) || workerLiveness.status === 'down' || !workerCompat.compatible
        ? 'degraded'
        : 'ok'

  const response: HealthStatus = {
    status: overallStatus,
    services,
    worker: {
      status: workerLiveness.status,
      lastSeenAt: workerLiveness.lastSeenAt,
      compatible: workerCompat.compatible,
      codeVersion: workerCompat.codeVersion,
      requiredVersion: workerCompat.requiredVersion,
      recovery: workerCompat.recovery,
    },
    ollamaModels,
    rag,
    ragDefaultEnabled,
    llmProvider: config.llm.provider,
    timestamp: new Date().toISOString(),
    mode: process.env.DATABASE_URL ? 'postgres' : 'local-workspace',
  }

  return Response.json(response, { status: overallStatus === 'error' ? 503 : 200 })
})
