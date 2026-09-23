import type { AnalysisConfig } from '@/lib/models/types'

export type StepState = 'pending' | 'running' | 'done' | 'error'
export type PhaseMap = Record<string, { state: StepState; count?: number | undefined }>

export type PipelineProgressEvent = {
  phase: string
  status: 'start' | 'done' | 'error'
  count?: number | undefined
  timestamp: number
}

const ANALYST_PHASE: Record<AnalysisConfig['enabledAnalysts'][number], string> = {
  stride: 'stride_analyst',
  pasta: 'pasta_analyst',
  attack_tree: 'attack_tree_analyst',
}

function isTerminal(state: StepState | undefined): boolean {
  return state === 'done' || state === 'error'
}

/**
 * Reduces duplicate SSE/poll events and refuses to display impossible
 * downstream states. Error is terminal for dependency purposes, but remains
 * visibly distinct from successful completion.
 */
export function derivePhases(
  events: PipelineProgressEvent[],
  enabledAnalysts: AnalysisConfig['enabledAnalysts'] = ['stride', 'pasta', 'attack_tree'],
): PhaseMap {
  const map: PhaseMap = {}
  for (const event of events) {
    const current = map[event.phase]?.state
    if (event.status === 'start' && !isTerminal(current)) {
      map[event.phase] = { state: 'running' }
    } else if (event.status === 'done') {
      map[event.phase] = { state: 'done', count: event.count }
    } else if (event.status === 'error') {
      map[event.phase] = { state: 'error' }
    }
  }

  const hideFrom = (phase: string) => {
    const downstream = ['pre_dedup', 'debate', 'threat_synthesizer', 'dread_validator']
    const start = downstream.indexOf(phase)
    for (const key of downstream.slice(start)) delete map[key]
  }

  if (!isTerminal(map.architecture_parser?.state)) {
    for (const key of Object.keys(map)) {
      if (key !== 'architecture_parser') delete map[key]
    }
    return map
  }

  const analystsFinished = enabledAnalysts
    .map((analyst) => ANALYST_PHASE[analyst])
    .every((phase) => isTerminal(map[phase]?.state))
  if (!analystsFinished) {
    hideFrom('pre_dedup')
    return map
  }
  if (!isTerminal(map.pre_dedup?.state)) {
    hideFrom('debate')
    return map
  }
  if (!isTerminal(map.debate?.state)) {
    hideFrom('threat_synthesizer')
    return map
  }
  if (!isTerminal(map.threat_synthesizer?.state)) {
    delete map.dread_validator
  }
  return map
}

export function phaseIsTerminal(state: StepState | undefined): boolean {
  return isTerminal(state)
}
