import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncPipelineCancellation } from '@/lib/pipeline-cancellation'
import { registerPipelineJob, clearPipelineJob } from '@/lib/pipeline-jobs'
import { isThreatModelCancellationRequested } from '@/lib/storage/threat-models'

vi.mock('@/lib/storage/threat-models', () => ({ isThreatModelCancellationRequested: vi.fn() }))
afterEach(() => { clearPipelineJob('durable-stop'); vi.resetAllMocks() })

describe('durable cancellation synchronization', () => {
  it('aborts an in-flight job when another process has recorded Stop', async () => {
    const signal = registerPipelineJob('durable-stop')
    vi.mocked(isThreatModelCancellationRequested).mockResolvedValue(true)
    await syncPipelineCancellation('durable-stop')
    expect(signal.aborted).toBe(true)
    expect(signal.reason.name).toBe('AbortError')
  })
  it('keeps a running job alive on a negative check or a transient storage failure', async () => {
    const signal = registerPipelineJob('durable-stop')
    vi.mocked(isThreatModelCancellationRequested).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('temporary database failure'))
    await syncPipelineCancellation('durable-stop')
    await expect(syncPipelineCancellation('durable-stop')).rejects.toThrow('temporary database failure')
    expect(signal.aborted).toBe(false)
  })
})
