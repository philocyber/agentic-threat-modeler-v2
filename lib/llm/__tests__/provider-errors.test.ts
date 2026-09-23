import { describe, expect, it } from 'vitest'
import { isProviderBillingError, ProviderBillingError, telemetryHasBillingFailure } from '../provider-errors'
import { assertRunCostBudget, emptyUsage, recordProviderFailure, runWithUsage } from '../usage'
import { toPublicErrorMessage } from '@/lib/utils/redact'

describe('provider billing failures', () => {
  it('distinguishes billing exhaustion from temporary throttling and unrelated insufficiency', () => {
    expect(isProviderBillingError({ status: 429, message: 'Rate limit exceeded' })).toBe(false)
    expect(isProviderBillingError(new Error('Insufficient context window'))).toBe(false)
    expect(isProviderBillingError({ cause: { error: { code: 'insufficient_quota' } } })).toBe(true)
    expect(isProviderBillingError(new Error('429 account PRIVATE-ACCOUNT is suspended due to insufficient balance, please recharge'))).toBe(true)
    expect(toPublicErrorMessage(new Error('insufficient balance for PRIVATE-ACCOUNT'))).toBe(new ProviderBillingError().message)
    expect(toPublicErrorMessage(new Error('Insufficient memory'))).not.toBe('Request was not authorized')
    expect(isProviderBillingError(new ProviderBillingError().message)).toBe(true)
    expect(toPublicErrorMessage(new Error('Unauthorized'))).toMatch(/authentication failed/i)
  })

  it('blocks subsequent calls in the affected run while other runs remain usable', async () => {
    await runWithUsage(emptyUsage(), async () => {
      assertRunCostBudget()
      recordProviderFailure(new Error('insufficient balance'))
      expect(() => assertRunCostBudget()).toThrow(ProviderBillingError)
      await runWithUsage(emptyUsage(), async () => expect(() => assertRunCostBudget()).not.toThrow())
      expect(() => assertRunCostBudget()).toThrow(ProviderBillingError)
    })
    expect(() => assertRunCostBudget()).not.toThrow()
  })

  it('handles cyclic errors and malformed historical telemetry safely', () => {
    const error: { cause?: unknown } = {}; error.cause = error
    expect(isProviderBillingError(error)).toBe(false)
    expect(telemetryHasBillingFailure('bad json\n' + JSON.stringify({ message: 'insufficient balance' }))).toBe(true)
    expect(telemetryHasBillingFailure(JSON.stringify({ message: 'rate limited' }))).toBe(false)
  })
})
