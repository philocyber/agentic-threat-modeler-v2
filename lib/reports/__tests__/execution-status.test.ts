import { describe, expect, it } from 'vitest'
import { describeRunExecution, isLegitimateZeroFindings } from '../execution-status'
import { generateMarkdownFromDB } from '@/lib/agents/report-generator'

describe('honest execution status', () => {
  it.each(['pending', 'running', undefined, 'unexpected'])('does not certify an unfinished or unknown run (%s)', status => {
    const execution = describeRunExecution({ status, threatCount: 0 })
    expect(execution.kind).not.toBe('completed')
    expect(isLegitimateZeroFindings(execution)).toBe(false)
    expect(execution.detail).not.toContain('finished every required stage')
  })

  it('does not conclude zero threats when a run failed with no findings', () => {
    const failed = describeRunExecution({
      status: 'failed',
      errorMessage: 'A cited passage is missing from the original architecture.',
      threatCount: 0,
    })
    expect(failed.kind).toBe('failed')
    expect(failed.detail).not.toMatch(/0 threats identified/i)
    expect(failed.detail).toMatch(/not a conclusion of zero threats|cited passage/i)
    expect(isLegitimateZeroFindings(failed)).toBe(false)
  })

  it('distinguishes a completed empty review from a failure', () => {
    const empty = describeRunExecution({ status: 'completed', threatCount: 0 })
    expect(empty.kind).toBe('completed')
    expect(isLegitimateZeroFindings(empty)).toBe(true)
    expect(empty.detail).toMatch(/architecture-supported/)
    const partial = describeRunExecution({
      status: 'partial', pipelineErrors: ['Debate batch failed'], threatCount: 2,
    })
    expect(partial.kind).toBe('partial')
    expect(partial.detail).toMatch(/not equivalent to an empty threat model/)
  })

  it('keeps failed markdown from concluding zero threats', () => {
    const markdown = generateMarkdownFromDB({
      threatModel: {
        id: 'tm_fail',
        title: 'Failed run',
        systemDescription: 'Gateway',
        createdAt: new Date('2026-09-15T00:00:00Z'),
        methodologiesUsed: ['STRIDE'],
        debateSummary: null,
        architectureJson: null,
        status: 'failed',
        errorMessage: 'A cited passage is missing from the original architecture.',
        pipelineErrors: null,
      },
      threats: [],
    })
    expect(markdown).toMatch(/\*\*Execution:\*\* failed/)
    expect(markdown).toMatch(/not produced \(run failed\)/)
    expect(markdown).not.toMatch(/0 threats identified/i)
  })
})
