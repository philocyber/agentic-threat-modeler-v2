import { describe, expect, it } from 'vitest'
import { classifyFailure, publicFailureMessage } from '../failure-class'
import { StructuredOutputError, StructuredOutputTruncatedError } from '../structured'
import { SourceCoverageError } from '@/lib/architecture/source-evidence'
import { ProviderBillingError } from '../provider-errors'
import { MandatoryAnalystError, primaryPipelineError } from '@/lib/pipeline/mandatory-analyst'
import { toPublicErrorMessage } from '@/lib/utils/redact'

describe('failure classification', () => {
  it('does not recommend increasing context for a citation rejection', () => {
    const error = new StructuredOutputError({
      agentName: 'StrideAnalyst',
      mechanism: 'ollama-json-schema',
      issues: [{ code: 'custom', path: ['threats', 0, 'evidenceSources'], message: 'Cite a catalog passage identifier (SRC-0001)' }],
      rawOutput: '{"threats":[]}',
    })
    expect(classifyFailure(error)).toBe('reference')
    expect(publicFailureMessage(error)).not.toMatch(/configure the model context/i)
    expect(toPublicErrorMessage(error)).toMatch(/reference failure/i)
    expect(toPublicErrorMessage(error)).not.toMatch(/configure the model context/i)
  })

  it('keeps invalid JSON, truncation, transport, auth and billing distinct', () => {
    expect(classifyFailure(new StructuredOutputError({
      agentName: 'x', mechanism: 'prompt-fallback', issues: [], rawOutput: 'not-json',
    }))).toBe('invalid_json')
    expect(classifyFailure(new StructuredOutputTruncatedError({
      agentName: 'x', mechanism: 'ollama-json-schema', outputTokens: 12,
    }))).toBe('truncation')
    expect(classifyFailure(new SourceCoverageError('too large'))).toBe('insufficient_context')
    expect(classifyFailure(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe('transport')
    expect(classifyFailure(Object.assign(new Error('Unauthorized'), { status: 401 }))).toBe('authentication')
    expect(classifyFailure(new ProviderBillingError())).toBe('billing')
  })

  it('keeps the original mandatory-analyst cause ahead of derived cancellation', () => {
    const cause = new StructuredOutputError({
      agentName: 'StrideAnalyst', mechanism: 'ollama-json-schema',
      issues: [{ code: 'custom', path: ['threats', 0, 'evidenceSources'], message: 'passage' }],
      rawOutput: '',
    })
    const primary = new MandatoryAnalystError('StrideAnalyst', cause)
    const derived = Object.assign(new Error('Stopped by user'), { name: 'AbortError', cause: primary })
    expect(primaryPipelineError(derived)).toBe(primary)
    expect(toPublicErrorMessage(derived)).toMatch(/reference failure/i)
  })
})
