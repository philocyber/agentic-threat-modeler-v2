import { buildStage2Fixture, type Stage2CaseKind } from './stage2-acceptance'

export const STAGE3_MAX_CALLS = 10
export const STAGE3_MAX_USD = 1
export const STAGE3_CASE_KINDS: Stage2CaseKind[] = ['supported_risk', 'absent_component']

export class Stage3CallBudgetError extends Error {
  readonly code = 'STAGE3_CALL_BUDGET'
  constructor(calls: number) {
    super(`Stage 3 stopped after ${calls} model calls (limit ${STAGE3_MAX_CALLS}).`)
    this.name = 'Stage3CallBudgetError'
  }
}

export function assertStage3CallBudget(calls: number): void {
  if (calls > STAGE3_MAX_CALLS) throw new Stage3CallBudgetError(calls)
}

/** Fictional review service only. Two cases fit one debate batch under the call cap. */
export function buildStage3Fixture(): ReturnType<typeof buildStage2Fixture> {
  const fixture = buildStage2Fixture()
  return { ...fixture, cases: fixture.cases.filter((item) => STAGE3_CASE_KINDS.includes(item.kind)) }
}
