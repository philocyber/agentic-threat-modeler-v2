export type BulkLifecycleMode = 'archive' | 'restore' | 'delete'

export type BulkLifecycleTarget = {
  id: string
  systemName: string
}

export type BulkLifecycleFailure = BulkLifecycleTarget & {
  error: string
}

export type BulkLifecycleResult = {
  succeeded: BulkLifecycleTarget[]
  failed: BulkLifecycleFailure[]
}

type RequestFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export async function runBulkLifecycleAction(
  targets: BulkLifecycleTarget[],
  mode: BulkLifecycleMode,
  request: RequestFn = fetch,
  onProgress?: (completed: number, total: number) => void,
): Promise<BulkLifecycleResult> {
  const succeeded: BulkLifecycleTarget[] = []
  const failed: BulkLifecycleFailure[] = []

  for (const target of targets) {
    try {
      const response = await request(`/api/v1/results/${encodeURIComponent(target.id)}`, {
        method: mode === 'delete' ? 'DELETE' : 'PATCH',
        ...(mode === 'delete'
          ? {}
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: mode }),
            }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      succeeded.push(target)
    } catch (error) {
      failed.push({
        ...target,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      onProgress?.(succeeded.length + failed.length, targets.length)
    }
  }

  return { succeeded, failed }
}
