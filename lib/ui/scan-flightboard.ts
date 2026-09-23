import type { AnalysisConfig } from '@/lib/models/types'
import type { PhaseMap, PipelineProgressEvent, StepState } from '@/lib/ui/progress-phases'

export type FlightboardStageId = 'discover' | 'challenge' | 'validate'
export type FlightboardStageState = 'queued' | 'running' | 'done' | 'warning'

export type FlightboardStage = {
  id: FlightboardStageId
  label: string
  summary: string
  phases: string[]
  state: FlightboardStageState
}

export type FlightboardActivity = {
  key: string
  phase: string
  title: string
  message: string
  status: PipelineProgressEvent['status']
  timestamp: number
}

export type FlightboardModel = {
  stages: FlightboardStage[]
  activeStageIndex: number
  activeStage: FlightboardStage
  activePhase: string
  activeTitle: string
  activeMessage: string
  analystSignals: number | undefined
  distinctCandidates: number | undefined
  validatedFindings: number | undefined
  activity: FlightboardActivity[]
}

type PhaseCopy = {
  title: string
  running: string
  done: (count?: number) => string
  error: string
}

const PHASE_COPY: Record<string, PhaseCopy> = {
  architecture_parser: {
    title: 'System architecture',
    running: 'Mapping components, trust boundaries, endpoints, and data flows.',
    done: () => 'System architecture checkpointed for the analyst team.',
    error: 'Architecture parsing failed before analysts could start.',
  },
  stride_analyst: {
    title: 'STRIDE analyst',
    running: 'Testing trust boundaries and components against STRIDE categories.',
    done: (count) => countMessage(count, 'candidate signal', 'checkpointed by STRIDE'),
    error: 'STRIDE stopped with a warning; the remaining analysts can continue.',
  },
  pasta_analyst: {
    title: 'PASTA analyst',
    running: 'Building risk-driven abuse scenarios from the system context.',
    done: (count) => countMessage(count, 'candidate scenario', 'checkpointed by PASTA'),
    error: 'PASTA stopped with a warning; the remaining analysts can continue.',
  },
  attack_tree_analyst: {
    title: 'Attack tree analyst',
    running: 'Tracing multi-step attack paths through the architecture.',
    done: (count) => countMessage(count, 'attack path', 'checkpointed'),
    error: 'Attack tree analysis stopped with a warning; the pipeline can continue.',
  },
  pre_dedup: {
    title: 'Candidate normalization',
    running: 'Merging overlapping signals before adversarial review.',
    done: (count) => countMessage(count, 'distinct candidate', 'kept after normalization'),
    error: 'Candidate normalization stopped with a warning.',
  },
  debate: {
    title: 'Red / Blue challenge',
    running: 'Challenging candidate applicability, impact, and supporting evidence.',
    done: (count) => countMessage(count, 'debate round', 'checkpointed'),
    error: 'Adversarial review degraded; synthesis will use the available evidence.',
  },
  threat_synthesizer: {
    title: 'Threat synthesis',
    running: 'Turning challenged candidates into coherent, traceable findings.',
    done: (count) => countMessage(count, 'finding draft', 'synthesized'),
    error: 'Threat synthesis stopped with a warning.',
  },
  dread_validator: {
    title: 'DREAD validation',
    running: 'Scoring severity and validating each finding against its evidence.',
    done: (count) => countMessage(count, 'validated finding', 'ready for review'),
    error: 'DREAD validation degraded; available findings will be delivered as partial results.',
  },
}

const FALLBACK_COPY: PhaseCopy = {
  title: 'Pipeline activity',
  running: 'The analysis pipeline is processing this stage.',
  done: () => 'The pipeline checkpointed this stage.',
  error: 'This stage stopped with a warning.',
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}

function countMessage(count: number | undefined, noun: string, action: string): string {
  if (count == null) return `Output ${action}.`
  return `${count} ${pluralize(count, noun)} ${action}.`
}

function isTerminal(state: StepState | undefined): boolean {
  return state === 'done' || state === 'error'
}

function stageState(phaseIds: string[], phases: PhaseMap): FlightboardStageState {
  const states = phaseIds.map((phase) => phases[phase]?.state)
  if (states.some((state) => state === 'running')) return 'running'
  if (states.every(isTerminal)) {
    return states.some((state) => state === 'error') ? 'warning' : 'done'
  }
  return 'queued'
}

function latestCount(events: PipelineProgressEvent[], phase: string): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.phase === phase && event.status === 'done' && event.count != null) return event.count
  }
  return undefined
}

function sumCounts(events: PipelineProgressEvent[], phases: string[]): number | undefined {
  const counts = phases
    .map((phase) => latestCount(events, phase))
    .filter((count): count is number => count != null)
  return counts.length > 0 ? counts.reduce((total, count) => total + count, 0) : undefined
}

function visiblePhaseSet(enabledAnalysts: AnalysisConfig['enabledAnalysts']): Set<string> {
  return new Set([
    'architecture_parser',
    ...(enabledAnalysts.includes('stride') ? ['stride_analyst'] : []),
    ...(enabledAnalysts.includes('pasta') ? ['pasta_analyst'] : []),
    ...(enabledAnalysts.includes('attack_tree') ? ['attack_tree_analyst'] : []),
    'pre_dedup',
    'debate',
    'threat_synthesizer',
    'dread_validator',
  ])
}

function dedupeActivity(events: PipelineProgressEvent[], visiblePhases: Set<string>): PipelineProgressEvent[] {
  const seen = new Set<string>()
  const output: PipelineProgressEvent[] = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || !visiblePhases.has(event.phase)) continue
    const key = `${event.phase}:${event.status}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(event)
    if (output.length === 5) break
  }
  return output
}

function activityFromEvent(event: PipelineProgressEvent): FlightboardActivity {
  const copy = PHASE_COPY[event.phase] ?? FALLBACK_COPY
  return {
    key: `${event.phase}:${event.status}:${event.timestamp}`,
    phase: event.phase,
    title: copy.title,
    message: event.status === 'start'
      ? copy.running
      : event.status === 'done'
        ? copy.done(event.count)
        : copy.error,
    status: event.status,
    timestamp: event.timestamp,
  }
}

export function deriveFlightboardModel({
  phases,
  events = [],
  enabledAnalysts = ['stride', 'pasta', 'attack_tree'],
}: {
  phases: PhaseMap
  events?: PipelineProgressEvent[]
  enabledAnalysts?: AnalysisConfig['enabledAnalysts']
}): FlightboardModel {
  const analystPhases = [
    ...(enabledAnalysts.includes('stride') ? ['stride_analyst'] : []),
    ...(enabledAnalysts.includes('pasta') ? ['pasta_analyst'] : []),
    ...(enabledAnalysts.includes('attack_tree') ? ['attack_tree_analyst'] : []),
  ]
  const definitions: Array<Omit<FlightboardStage, 'state'>> = [
    {
      id: 'discover',
      label: 'Discover',
      summary: 'Map the system and surface candidate signals',
      phases: ['architecture_parser', ...analystPhases],
    },
    {
      id: 'challenge',
      label: 'Challenge',
      summary: 'Normalize overlap and test candidate validity',
      phases: ['pre_dedup', 'debate'],
    },
    {
      id: 'validate',
      label: 'Validate',
      summary: 'Synthesize, score, and validate final findings',
      phases: ['threat_synthesizer', 'dread_validator'],
    },
  ]
  const stages = definitions.map((stage) => ({
    ...stage,
    state: stageState(stage.phases, phases),
  }))

  let activeStageIndex = stages.findIndex((stage) => stage.state === 'running')
  if (activeStageIndex < 0) activeStageIndex = stages.findIndex((stage) => stage.state === 'queued')
  if (activeStageIndex < 0) activeStageIndex = Math.max(stages.length - 1, 0)
  const activeStage = stages[activeStageIndex]!
  if (activeStage.state === 'queued') activeStage.state = 'running'

  const activePhase = activeStage.phases.find((phase) => phases[phase]?.state === 'running')
    ?? activeStage.phases.find((phase) => !isTerminal(phases[phase]?.state))
    ?? activeStage.phases.at(-1)
    ?? 'architecture_parser'
  const activeCopy = PHASE_COPY[activePhase] ?? FALLBACK_COPY
  const visiblePhases = visiblePhaseSet(enabledAnalysts)

  return {
    stages,
    activeStageIndex,
    activeStage,
    activePhase,
    activeTitle: activeCopy.title,
    activeMessage: activeCopy.running,
    analystSignals: sumCounts(events, analystPhases),
    distinctCandidates: latestCount(events, 'pre_dedup'),
    validatedFindings: latestCount(events, 'dread_validator'),
    activity: dedupeActivity(events, visiblePhases).map(activityFromEvent),
  }
}

export function phaseCopy(phase: string): PhaseCopy {
  return PHASE_COPY[phase] ?? FALLBACK_COPY
}
