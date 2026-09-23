import { describe, expect, it, vi } from 'vitest'
import { withOllamaInferenceSlot } from '../ollama-queue'

describe('Ollama inference queue', () => {
  it('cancels a queued request promptly without releasing the active request', async () => {
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const endpoint = 'http://127.0.0.1:11435'
    const active = withOllamaInferenceSlot(endpoint, undefined, async () => {
      started.resolve()
      await gate.promise
    })
    await started.promise
    const controller = new AbortController()
    const cancelledRun = vi.fn()
    const queued = withOllamaInferenceSlot(endpoint, controller.signal, cancelledRun)
    const rejection = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    const follower = vi.fn()
    const last = withOllamaInferenceSlot(endpoint, undefined, follower)
    try {
      const result = await Promise.race([
        rejection.then(() => 'cancelled'),
        new Promise(resolve => setTimeout(() => resolve('still waiting'), 50)),
      ])
      expect(result).toBe('cancelled')
      expect(cancelledRun).not.toHaveBeenCalled()
      expect(follower).not.toHaveBeenCalled()
    } finally {
      gate.resolve()
      await Promise.all([active, rejection, last])
    }
    expect(follower).toHaveBeenCalledOnce()
  })

  it('runs one active call per endpoint and measures wait separately', async () => {
    let active = 0
    let maxActive = 0
    const order: string[] = []
    const slow = withOllamaInferenceSlot('http://127.0.0.1:11434', undefined, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      order.push('slow-start')
      await new Promise((resolve) => setTimeout(resolve, 30))
      active -= 1
      order.push('slow-end')
      return 'slow'
    })
    const fast = withOllamaInferenceSlot('http://127.0.0.1:11434', undefined, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      order.push('fast')
      active -= 1
      return 'fast'
    })
    const [first, second] = await Promise.all([slow, fast])
    expect(first.value).toBe('slow')
    expect(second.value).toBe('fast')
    expect(maxActive).toBe(1)
    expect(order).toEqual(['slow-start', 'slow-end', 'fast'])
    expect(second.waitMs).toBeGreaterThan(0)
  })
})
