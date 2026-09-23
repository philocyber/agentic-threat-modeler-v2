import { describe, expect, it, vi } from 'vitest'
import { runBulkLifecycleAction } from '@/lib/ui/bulk-run-lifecycle'

const TARGETS = [
  { id: 'run/one', systemName: 'Checkout API' },
  { id: 'run-two', systemName: 'Fulfillment API' },
]

describe('runBulkLifecycleAction', () => {
  it('archives each selected run and reports progress', async () => {
    const request = vi.fn(async () => Response.json({ ok: true }))
    const onProgress = vi.fn()

    const result = await runBulkLifecycleAction(TARGETS, 'archive', request, onProgress)

    expect(request).toHaveBeenNthCalledWith(1, '/api/v1/results/run%2Fone', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'archive' }),
    })
    expect(result).toEqual({ succeeded: TARGETS, failed: [] })
    expect(onProgress).toHaveBeenLastCalledWith(2, 2)
  })

  it('uses DELETE and preserves per-run failures', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ error: 'Run is locked' }, { status: 409 }))

    const result = await runBulkLifecycleAction(TARGETS, 'delete', request)

    expect(request).toHaveBeenNthCalledWith(1, '/api/v1/results/run%2Fone', { method: 'DELETE' })
    expect(result.succeeded).toEqual([TARGETS[0]])
    expect(result.failed).toEqual([{ ...TARGETS[1], error: 'Run is locked' }])
  })
})
