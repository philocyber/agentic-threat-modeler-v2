/**
 * In-memory progress store for running analyses.
 * Cleared when analysis completes or fails.
 * Survives only within the current server process — fine for dev/local use.
 */

import { EventEmitter } from 'events'
import { classifyTelemetryMessage, type TelemetryLine } from '@/lib/runs/telemetry'

export type ProgressEvent = {
  phase: string
  status: 'start' | 'done' | 'error'
  count?: number | undefined
  timestamp: number
}

// Security limits
const MAX_EVENTS_PER_ANALYSIS = 1000
const MAX_LOGS_PER_ANALYSIS = 500
const CLEANUP_INTERVAL_MS = 3600000 // 1 hour
const MAX_AGE_MS = 86400000 // 24 hours

const _store = new Map<string, ProgressEvent[]>()
const _logStore = new Map<string, TelemetryLine[]>()
const _timestamps = new Map<string, number>() // Track last activity
const progressEmitter = new EventEmitter()

// Prevent EventEmitter memory leak warnings
progressEmitter.setMaxListeners(100)

// Periodic cleanup of stale entries (memory leak protection)
const cleanupInterval = setInterval(() => {
  const now = Date.now()
  const staleIds: string[] = []
  
  _timestamps.forEach((timestamp, analysisId) => {
    if (now - timestamp > MAX_AGE_MS) {
      staleIds.push(analysisId)
    }
  })
  
  staleIds.forEach((id) => {
    _store.delete(id)
    _logStore.delete(id)
    _timestamps.delete(id)
    console.log(`[pipeline-progress] Cleaned up stale analysis: ${id}`)
  })
}, CLEANUP_INTERVAL_MS)
cleanupInterval.unref?.()

export function pushProgress(analysisId: string, event: ProgressEvent): void {
  const existing = _store.get(analysisId) ?? []
  
  // Limit array size to prevent memory exhaustion
  const updated = [...existing, event].slice(-MAX_EVENTS_PER_ANALYSIS)
  _store.set(analysisId, updated)
  
  // Update timestamp for cleanup tracking
  _timestamps.set(analysisId, Date.now())
  
  // Emit event for subscribers
  progressEmitter.emit('progress', { analysisId, event })
}

export function getProgress(analysisId: string): ProgressEvent[] {
  return _store.get(analysisId) ?? []
}

export function clearProgress(analysisId: string): void {
  _store.delete(analysisId)
  _logStore.delete(analysisId)
  _timestamps.delete(analysisId)
}

export function pushLog(analysisId: string, message: string): TelemetryLine {
  const line = classifyTelemetryMessage(message)
  const existing = _logStore.get(analysisId) ?? []
  const updated = [...existing, line].slice(-MAX_LOGS_PER_ANALYSIS)
  _logStore.set(analysisId, updated)
  _timestamps.set(analysisId, Date.now())
  progressEmitter.emit('log', { analysisId, event: line })
  return line
}

export function getLogs(analysisId: string): TelemetryLine[] {
  return _logStore.get(analysisId) ?? []
}

export function subscribeToLogs(
  analysisId: string,
  callback: (event: TelemetryLine) => void,
): () => void {
  const handler = (data: { analysisId: string; event: TelemetryLine }) => {
    if (data.analysisId === analysisId) callback(data.event)
  }
  progressEmitter.on('log', handler)
  return () => progressEmitter.off('log', handler)
}

/**
 * Subscribe to progress events for a specific analysis.
 * Returns an unsubscribe function.
 */
export function subscribeToProgress(
  analysisId: string,
  callback: (event: ProgressEvent) => void
): () => void {
  const handler = (data: { analysisId: string; event: ProgressEvent }) => {
    if (data.analysisId === analysisId) {
      callback(data.event)
    }
  }

  progressEmitter.on('progress', handler)
  return () => progressEmitter.off('progress', handler)
}
