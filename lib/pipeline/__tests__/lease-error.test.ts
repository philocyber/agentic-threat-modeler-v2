import { describe, expect, it } from 'vitest'
import { isPipelineLeaseLost, leaseLostError, PipelineLeaseLostError } from '@/lib/pipeline/lease-error'

describe('pipeline lease loss', () => {
  it('is distinct from a user abort so a displaced worker does not fail the successor', () => {
    const lost = leaseLostError()
    expect(lost).toBeInstanceOf(PipelineLeaseLostError)
    expect(isPipelineLeaseLost(lost)).toBe(true)
    expect(isPipelineLeaseLost({ name: 'AbortError', message: 'Stopped by user' })).toBe(false)
    const abort = new Error('Stopped by user')
    abort.name = 'AbortError'
    expect(isPipelineLeaseLost(abort)).toBe(false)
  })
})
