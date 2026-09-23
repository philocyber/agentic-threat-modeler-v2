import { describe, expect, it, vi } from 'vitest'
import { bumpRAGIndexGeneration, registerRAGIndexInvalidator } from '../index-generation'

describe('RAG index generation', () => {
  it('invalidates registered runtime stores after a completed reindex', () => {
    const technical = vi.fn()
    const corporate = vi.fn()
    registerRAGIndexInvalidator('test-technical', technical)
    registerRAGIndexInvalidator('test-corporate', corporate)

    const generation = bumpRAGIndexGeneration()

    expect(generation).toBeGreaterThan(0)
    expect(technical).toHaveBeenCalledOnce()
    expect(corporate).toHaveBeenCalledOnce()
  })
})
