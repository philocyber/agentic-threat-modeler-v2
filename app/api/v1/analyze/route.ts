import { AnalysisConfigError, clampAnalysisConfig } from '@/lib/api/analysis-config'
import { probeOllamaModels } from '@/lib/health/ollama-models'
import { unresolvedLargeInputModels } from '@/lib/llm/context-capacity'
import type { AnalysisMetadata } from '@/lib/db/schema'
import { workspaceRoute } from '@/lib/local-route'
import { createThreatModel, getThreatModel } from '@/lib/storage/threat-models'
import { getUploadsByIds, sweepExpiredUploads } from '@/lib/storage/uploads'
import { getConfig } from '@/lib/config'
import { probeRagHealth } from '@/lib/health/rag-status'
import { unpricedSelectedCloudModels } from '@/lib/llm/usage'
import { readWorkerLiveness } from '@/lib/pipeline/worker-liveness'
import { workerCompatibility } from '@/lib/pipeline/worker-version'
import { logger } from '@/lib/logger'
import type { AnalyzeRequest, AnalyzeResponse, AnalysisConfig } from '@/lib/models/types'
import { calculateVersionHash } from '@/lib/utils/version-hash'
import { validateWebhookUrlStructure } from '@/lib/utils/ssrf'
import { checkRateLimit, rateLimitSubject } from '@/lib/utils/rate-limit'
import { getActor } from '@/lib/security/actor'
import { generateThreatModelId } from '@/lib/db/helpers'
import { findOrCreateSystemByName, getSystem } from '@/lib/storage/systems'
import { getRAGIndexReadiness } from '@/lib/rag/index-state'
import {
  createRunManifest,
  manifestModelSettings,
  incompatibleManifestCategories,
  isRunManifestV2,
} from '@/lib/runs/run-manifest'
import { AnalyzeRequestSchema } from '@/lib/api/schemas'

export const maxDuration = 3800

const MAX_INPUT_SIZE = 500_000
const MAX_SYSTEM_NAME_LENGTH = 255
const MAX_UPLOAD_IDS = 20

export const POST = workspaceRoute(async (req, { workspace }) => {
  await sweepExpiredUploads()
  logger.setContext({
    requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
    ...logger.extractRequestMetadata(req),
  })

  try {
    if (!workspace && !process.env.DATABASE_URL) {
      return Response.json(
        {
          error: 'Select or create a local project before starting an analysis.',
          code: 'NO_ACTIVE_PROJECT',
        },
        { status: 409 },
      )
    }

    const rl = checkRateLimit(`analyze:${rateLimitSubject(req.headers, getActor()?.id)}`, 10, 60_000)
    if (!rl.allowed) {
      return Response.json(
        {
          error: 'rate_limited',
          error_description: 'Too many analysis requests',
          retry_after: rl.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { 'Retry-After': String(rl.retryAfterSeconds) },
        }
      )
    }

    let rawBody: unknown
    try {
      rawBody = await req.json()
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsedBody = AnalyzeRequestSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return Response.json({
        error: 'Invalid analysis request',
        issues: parsedBody.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      }, { status: 400 })
    }
    const body = parsedBody.data as AnalyzeRequest

    // Validation
    if (!body.input.trim() && !body.upload_ids?.length) {
      return Response.json({ error: 'input or at least one upload_id is required' }, { status: 400 })
    }

    if (body.input.length > MAX_INPUT_SIZE) {
      return Response.json(
        { error: `input exceeds maximum size of ${MAX_INPUT_SIZE} bytes` },
        { status: 413 }
      )
    }

    if (body.systemName.length > MAX_SYSTEM_NAME_LENGTH) {
      return Response.json(
        { error: `systemName exceeds maximum length of ${MAX_SYSTEM_NAME_LENGTH} characters` },
        { status: 400 }
      )
    }

    // Structural webhook SSRF check at request time (https only)
    if (body.webhookUrl) {
      const webhookCheck = validateWebhookUrlStructure(body.webhookUrl)
      if (!webhookCheck.ok) {
        return Response.json({ error: webhookCheck.error }, { status: 400 })
      }
    }

    // Validate metadata fields (whitelist approach)
    if (body.metadata) {
      const allowedFields = [
        'source',
        'rfc_id',
        'rfc_document_id',
        'rfc_version',
        'project_id',
        'workflow_execution_id',
      ]
      const providedFields = Object.keys(body.metadata)
      const invalidFields = providedFields.filter((f) => !allowedFields.includes(f))
      if (invalidFields.length > 0) {
        return Response.json(
          { error: `Invalid metadata fields: ${invalidFields.join(', ')}` },
          { status: 400 }
        )
      }
    }

    const appConfig = getConfig()
    let analysisConfig: AnalysisConfig
    try {
      analysisConfig = clampAnalysisConfig(body.config, appConfig)
    } catch (error) {
      if (error instanceof AnalysisConfigError) {
        return Response.json({ error: error.message }, { status: 400 })
      }
      throw error
    }

    const workerCompat = workerCompatibility(await readWorkerLiveness())
    if (!workerCompat.compatible) {
      return Response.json({
        error: 'The live pipeline worker is incompatible with this code. No analysis has started.',
        code: 'WORKER_INCOMPATIBLE',
        requiredVersion: workerCompat.requiredVersion,
        workerVersion: workerCompat.codeVersion,
        recovery: workerCompat.recovery,
      }, { status: 409 })
    }

    if (analysisConfig.provider === 'ollama') {
      const readiness = await probeOllamaModels(appConfig.llm.ollamaBaseUrl,
        [analysisConfig.quickModel, analysisConfig.deepModel].filter((model): model is string => Boolean(model)))
      if (!readiness.ready) return Response.json({
        code: readiness.reachable ? 'OLLAMA_MODEL_MISSING' : 'OLLAMA_UNAVAILABLE',
        error: readiness.reachable
          ? `Selected Ollama models are not installed: ${readiness.missingModels.join(', ')}. Select installed models or install the missing models before retrying. No analysis has started.`
          : 'Ollama is unavailable. Start the configured local service before retrying. No analysis has started.',
        ...readiness,
      }, { status: readiness.reachable ? 409 : 503 })
    }

    const unpricedModels = unpricedSelectedCloudModels(
      analysisConfig.provider,
      [analysisConfig.quickModel, analysisConfig.deepModel].filter((model): model is string => Boolean(model)),
    )
    if (unpricedModels.length > 0) {
      return Response.json({
        error: 'MAX_RUN_COST_USD requires prices for every selected cloud model.',
        code: 'LLM_PRICE_MISSING',
        models: unpricedModels,
      }, { status: 409 })
    }

    if (analysisConfig.useRag !== false) {
      const ragHealth = await probeRagHealth({
        ...appConfig.rag,
        ollamaBaseUrl: appConfig.llm.ollamaBaseUrl,
      })
      if (!ragHealth.usable) {
        return Response.json(
          {
            error: ragHealth.reason,
            code: 'RAG_UNAVAILABLE',
            rag: ragHealth,
          },
          { status: 409 },
        )
      }
    }

    // Checkpoints live in the workspace filesystem, so only a run this workspace
    // can see may seed another. getThreatModel is already workspace-scoped.
    let resumeFrom: string | undefined
    let resumeSource: Awaited<ReturnType<typeof getThreatModel>> | null = null
    if (typeof body.resumeFrom === 'string' && body.resumeFrom.length > 0) {
      resumeSource = await getThreatModel(body.resumeFrom)
      if (!resumeSource) {
        return Response.json({ error: 'resumeFrom run not found in this project' }, { status: 404 })
      }
      resumeFrom = resumeSource.id
    }

    let resolvedInput = body.input
    let supportingDocuments: Array<{ upload_id: string; name: string; type: string }> | undefined
    let hashDocs: Array<{ name: string; content: string }> | undefined

    if (body.upload_ids && body.upload_ids.length > MAX_UPLOAD_IDS) {
      return Response.json(
        { error: `upload_ids exceeds maximum of ${MAX_UPLOAD_IDS}` },
        { status: 400 }
      )
    }

    if (body.upload_ids && body.upload_ids.length > 0) {
      const rows = await getUploadsByIds(body.upload_ids)
      const now = new Date()
      const valid = rows.filter((row) => row.expiresAt > now)

      if (valid.length !== new Set(body.upload_ids).size) {
        return Response.json(
          { error: 'One or more uploads are unavailable' },
          { status: 404 }
        )
      }

      if (valid.length > 0) {
        supportingDocuments = valid.map((r) => ({
          upload_id: r.id,
          name: r.originalName,
          type: r.mediaType,
        }))
        hashDocs = valid.map((r) => ({ name: r.originalName, content: r.content }))

        const appended = valid
          .map((r) => `\n\n--- Supporting Document: ${r.originalName} (${r.mediaType}) ---\n${r.content}`)
          .join('')
        resolvedInput = body.input + appended

        if (resolvedInput.length > MAX_INPUT_SIZE) {
          return Response.json(
            { error: `input + uploads exceed maximum size of ${MAX_INPUT_SIZE} bytes` },
            { status: 413 }
          )
        }
      }
    }

    try {
      const unresolved = unresolvedLargeInputModels(analysisConfig.provider,
        [analysisConfig.quickModel, analysisConfig.deepModel].filter((name): name is string => Boolean(name)), resolvedInput.length)
      if (unresolved.length) return Response.json({
        code: 'MODEL_CONTEXT_UNVERIFIED',
        error: 'Configure verified context capacities in MODEL_CONTEXT_WINDOWS for these models before starting a large analysis. No inference has started.',
        models: unresolved,
      }, { status: 409 })
    } catch {
      return Response.json({ code: 'MODEL_CONTEXT_INVALID', error: 'MODEL_CONTEXT_WINDOWS must contain valid context capacities keyed by exact model ID.' }, { status: 400 })
    }

    const versionHash = calculateVersionHash({
      systemName: body.systemName,
      input: resolvedInput,
      supportingDocuments: hashDocs,
    })

    let systemId: string | undefined
    if (body.systemId?.trim()) {
      const existing = await getSystem(body.systemId.trim())
      if (!existing) {
        return Response.json({ error: 'systemId not found' }, { status: 404 })
      }
      systemId = existing.id
    } else {
      const system = await findOrCreateSystemByName(body.systemName.trim(), body.input.slice(0, 500))
      systemId = system.id
    }

    const ragIndex = analysisConfig.useRag === false
      ? { snapshot: { fingerprint: 'rag-disabled' } }
      : await getRAGIndexReadiness(appConfig.rag.embeddingModel, appConfig.rag.knowledgeBasePath)
    const runManifest = createRunManifest({
      inputFingerprint: versionHash,
      systemId,
      config: analysisConfig,
      ragIndexFingerprint: ragIndex.snapshot.fingerprint,
      modelSettings: manifestModelSettings(appConfig, analysisConfig),
    })

    if (resumeSource) {
      const previousManifest = resumeSource.metadata?.run_manifest
      const incompatible = isRunManifestV2(previousManifest)
        ? incompatibleManifestCategories(previousManifest, runManifest)
        : ['legacy_manifest']
      if (incompatible.length > 0) {
        return Response.json({
          error: 'The selected run cannot be resumed with this request.',
          code: 'CHECKPOINT_INCOMPATIBLE',
          incompatible,
        }, { status: 409 })
      }
    }

    const metadata: AnalysisMetadata = {
      ...body.metadata,
      analyzed_at: new Date().toISOString(),
      version_hash: versionHash,
      input_type: body.inputType ?? 'text',
      analysis_config: analysisConfig,
      run_manifest: runManifest,
      ...(resumeFrom ? { resumeFrom } : {}),
      ...(body.webhookSecret ? { webhook_secret: body.webhookSecret } : {}),
    }

    const tmId = generateThreatModelId()

    const threatModel = await createThreatModel({
      id: tmId,
      systemId,
      title: body.systemName,
      input: resolvedInput,
      supportingDocuments: supportingDocuments ?? null,
      status: 'pending',
      metadata,
      versionHash,
      externalId: body.externalId,
      webhookUrl: body.webhookUrl ?? null,
    })

    logger.info(
      'Analysis requested',
      {
        analysisId: threatModel.id,
        systemName: body.systemName,
      },
      { audit: { eventType: 'analysis_requested' } }
    )

    const responseBody: AnalyzeResponse = {
      analysisId: threatModel.id,
      status: 'pending',
      metadata,
      status_url: `/api/v1/analysis/${threatModel.id}/status`,
      created_at: threatModel.createdAt.toISOString(),
    }

    return Response.json(responseBody, { status: 202 })
  } finally {
    logger.clearContext()
  }
})
