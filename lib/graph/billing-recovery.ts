import type { PhaseOutput } from './builder'
import type { ThreatModelState } from '@/lib/models/types'
import { rawToUnified } from '@/lib/agents/reconcile'
import { isProviderBillingError, ProviderBillingError } from '@/lib/llm/provider-errors'

/** Recover completed phase outputs without generating or pretending to validate anything. */
export function recoverBillingBlockedResult(
  seed: Partial<ThreatModelState>,
  outputs: PhaseOutput[],
  error: unknown,
): Partial<ThreatModelState> {
  if (!isProviderBillingError(error)) throw error
  const state = { ...seed, errors: [...(seed.errors ?? [])] }
  for (const output of outputs) {
    if ('degraded' in output) { state.errors.push(output.error); continue }
    if ('architecture' in output) state.architectureData = output.architecture
    if ('threats' in output) {
      const key = { stride_analyst: 'strideThreats', pasta_analyst: 'pastaThreats', attack_tree_analyst: 'attackTreeThreats' } as const
      state[key[output.phase]] = output.threats
    }
    if ('threatsKept' in output) { state.threatsKept = output.threatsKept; state.filteredCount = output.filteredCount }
    if ('debateRounds' in output) state.debateRounds = output.debateRounds
    if ('threatsPreDedup' in output) state.threatsPreDedup = output.threatsPreDedup
    if ('threatsFinal' in output) { state.threatsFinal = output.threatsFinal; state.filteredCount = output.filteredCount }
  }
  // No architecture means the parser never completed: keep the normal failed-run path.
  if (!state.architectureData) throw new ProviderBillingError()
  state.threatsFinal ??= state.threatsPreDedup ?? (state.threatsKept ?? [
    ...(state.strideThreats ?? []), ...(state.pastaThreats ?? []), ...(state.attackTreeThreats ?? []),
  ]).map(rawToUnified)
  state.errors.push(`${new ProviderBillingError().message} Remaining model stages were stopped; completed outputs are preserved and unfinished validation remains incomplete.`)
  return state
}
