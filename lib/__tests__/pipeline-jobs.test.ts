import { describe, expect, it, vi } from 'vitest'

describe('pipeline job cancellation across module reloads', () => {
  it('aborts the original job from a fresh route module without affecting another job', async () => {
    const original = await import('@/lib/pipeline-jobs')
    const signal = original.registerPipelineJob('reload-target')
    const other = original.registerPipelineJob('reload-other')
    vi.resetModules()
    const reloaded = await import('@/lib/pipeline-jobs')
    expect(reloaded.abortPipelineJob('reload-target')).toBe(true)
    expect(signal.aborted).toBe(true)
    expect(other.aborted).toBe(false)
    reloaded.abortPipelineJob('reload-other')
    expect(other.aborted).toBe(true)
    expect(reloaded.abortPipelineJob('reload-target')).toBe(false)
  })
})
