import { describe, expect, it } from 'vitest'
import { STAGE2_SOURCE } from '../stage2-acceptance'
import {
  STAGE3_CASE_KINDS,
  STAGE3_MAX_CALLS,
  Stage3CallBudgetError,
  assertStage3CallBudget,
  buildStage3Fixture,
} from '../stage3-kimi'

describe('stage 3 Kimi fixture', () => {
  it('uses the fictional ReviewDesk source and two cases that fit the call cap', () => {
    const fixture = buildStage3Fixture()
    expect(STAGE2_SOURCE).toContain('ReviewDesk')
    expect(fixture.cases.map((item) => item.kind)).toEqual(STAGE3_CASE_KINDS)
    expect(fixture.cases).toHaveLength(2)
    expect(STAGE3_MAX_CALLS).toBe(10)
    expect(() => assertStage3CallBudget(10)).not.toThrow()
    expect(() => assertStage3CallBudget(11)).toThrow(Stage3CallBudgetError)
  })
})
