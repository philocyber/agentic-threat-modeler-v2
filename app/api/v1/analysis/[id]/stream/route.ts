import { workspaceRoute } from '@/lib/local-route'
import { analysisDeliveredResults, isTerminalAnalysisStatus } from '@/lib/models/analysis-status'
import type { SSEEvent } from '@/lib/models/types'
import { parseProgressEvents } from '@/lib/runs/progress-events'
import { readAppendedJsonlLines, type JsonlTailCursor } from '@/lib/runs/jsonl-tail'
import { classifyTelemetryMessage } from '@/lib/runs/telemetry'
import { readRunArtifactTextLenient } from '@/lib/storage/artifacts'
import { getThreatModel, getThreatModelPollSnapshot } from '@/lib/storage/threat-models'
import { getActor } from '@/lib/security/actor'
import { reserveSseConnection } from '@/lib/utils/sse-connections'
import { resolvePipelineTimeouts } from '@/lib/pipeline-timeouts'

/**
 * The stream must outlive the pipeline it reports on: a fixed short cap cut
 * long runs off mid-flight, leaving the UI frozen on a run that was still
 * advancing. Track the pipeline budget plus a margin for the final write.
 */
const { pipelineTimeoutMs: PIPELINE_TIMEOUT_MS } = resolvePipelineTimeouts()
const STREAM_TIMEOUT_MS = PIPELINE_TIMEOUT_MS + 120_000

export const GET = workspaceRoute(async (req, { params }) => {
  if (!params?.id) {
    return Response.json({ error: 'Missing analysis ID' }, { status: 400 })
  }
  const analysisId = params.id

  const threatModel = await getThreatModel(analysisId)

  if (!threatModel) {
    return Response.json({ error: 'Threat model not found' }, { status: 404 })
  }

  // Already finished: send the final event and close. `partial` counts as a
  // delivery — the run produced threats even though a phase degraded.
  if (isTerminalAnalysisStatus(threatModel.status)) {
    const delivered = analysisDeliveredResults(threatModel.status)
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        const event = delivered ? 'complete' : 'error'
        const data = {
          analysisId: threatModel.id,
          status: threatModel.status,
          ...(delivered && {
            totalThreats: threatModel.totalThreats,
            durationMs: threatModel.executionTimeSeconds ? threatModel.executionTimeSeconds * 1000 : null,
          }),
          ...(!delivered && {
            message: threatModel.errorMessage,
            stop_reason: threatModel.cancelRequestedAt ? 'user_cancelled' : undefined,
          }),
        }
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        controller.close()
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  const reservation = reserveSseConnection(getActor()?.id ?? 'anonymous', analysisId)
  if (!reservation.allowed) {
    return Response.json(
      { error: 'SSE_CONNECTION_LIMIT', message: 'Too many concurrent streams for this run.' },
      { status: 429, headers: { 'Retry-After': '5' } },
    )
  }
  const releaseConnection = reservation.release

  // Analysis is in progress - stream events
  const encoder = new TextEncoder()
  let cancelStream: (() => void) | undefined
  const stream = new ReadableStream({
    async start(controller) {
      // Correlates each event name with its payload, so a drifting `send` call
      // fails the build instead of silently shipping a malformed event.
      function send<E extends SSEEvent['event']>(
        event: E,
        data: Extract<SSEEvent, { event: E }>['data'],
      ) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      let pollInterval: NodeJS.Timeout | null = null
      let timeout: NodeJS.Timeout | null = null
      let isClosed = false
      let polling = false
      let telemetryCursor: JsonlTailCursor = { offset: 0, tail: '' }
      let lastTelemetryRead = 0
      const seenProgress = new Set<string>()

      function cleanup() {
        if (isClosed) return
        isClosed = true
        if (pollInterval) clearInterval(pollInterval)
        if (timeout) clearTimeout(timeout)
        releaseConnection()
        try {
          controller.close()
        } catch {
          // Controller already closed
        }
      }
      cancelStream = cleanup

      send('started', {
        analysisId: threatModel.id,
        status: threatModel.status,
      })

      async function emitPersisted(includeTelemetry: boolean): Promise<void> {
        const progressText = await readRunArtifactTextLenient(analysisId, 'progress.jsonl')
        for (const event of parseProgressEvents(progressText ?? '')) {
          const key = `${event.phase}:${event.status}:${event.timestamp}`
          if (seenProgress.has(key)) continue
          seenProgress.add(key)
          send('progress', {
            phase: event.phase,
            status: event.status,
            count: event.count,
            timestamp: event.timestamp,
          })
        }
        if (!includeTelemetry) return
        const telemetryText = await readRunArtifactTextLenient(analysisId, 'telemetry.jsonl')
        const { lines, cursor } = readAppendedJsonlLines(telemetryText, telemetryCursor)
        telemetryCursor = cursor
        for (const line of lines) {
          try {
            const record: unknown = JSON.parse(line)
            if (!record || typeof record !== 'object' || typeof (record as { message?: unknown }).message !== 'string') continue
            const message = (record as { message: string }).message
            const at = typeof (record as { at?: unknown }).at === 'number'
              ? (record as { at: number }).at
              : Date.now()
            const classified = classifyTelemetryMessage(message, at)
            send('log', { message: classified.message, at: classified.at, kind: classified.kind })
          } catch {
            continue
          }
        }
      }

      await emitPersisted(true)
      lastTelemetryRead = Date.now()

      pollInterval = setInterval(async () => {
        if (isClosed || polling) return
        polling = true
        try {
          const now = Date.now()
          const includeTelemetry = now - lastTelemetryRead >= 5000
          await emitPersisted(includeTelemetry)
          if (includeTelemetry) lastTelemetryRead = now
          const current = await getThreatModelPollSnapshot(analysisId)
          if (analysisDeliveredResults(current?.status)) {
            send('complete', {
              analysisId,
              status: current!.status,
              totalThreats: current!.totalThreats,
              durationMs: current!.executionTimeSeconds ? current!.executionTimeSeconds * 1000 : null,
            })
            cleanup()
          } else if (current?.status === 'failed') {
            send('error', {
              analysisId,
              message: current.errorMessage,
              stop_reason: current.cancelRequestedAt ? 'user_cancelled' : undefined,
            })
            cleanup()
          }
        } catch (err) {
          console.error(`[stream] Poll error for ${analysisId}:`, err)
        } finally {
          polling = false
        }
      }, 1000)

      timeout = setTimeout(() => {
        if (isClosed) return
        send('timeout', {
          message: `Stream timeout after ${Math.round(STREAM_TIMEOUT_MS / 60000)} minutes`,
        })
        cleanup()
      }, STREAM_TIMEOUT_MS)

      req.signal.addEventListener('abort', () => {
        cleanup()
      }, { once: true })
    },
    cancel() {
      cancelStream?.()
      releaseConnection()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Analysis-Id': analysisId,
    },
  })
})
