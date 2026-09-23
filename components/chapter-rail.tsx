import type { AnalysisConfig } from '@/lib/models/types'
import type { PhaseMap, StepState } from '@/lib/ui/progress-phases'

type ChapterRailProps = {
  phases: PhaseMap
  enabledAnalysts?: AnalysisConfig['enabledAnalysts'] | undefined
}

type RailState = StepState | 'skipped'

const CHAPTERS = [
  {
    title: 'Analyze',
    width: 'lg:col-span-2',
    steps: [
      { id: 'architecture_parser', label: 'Architecture' },
      { id: 'stride_analyst', label: 'STRIDE', analyst: 'stride' },
      { id: 'pasta_analyst', label: 'PASTA', analyst: 'pasta' },
      { id: 'attack_tree_analyst', label: 'Attack trees', analyst: 'attack_tree' },
    ],
  },
  {
    title: 'Challenge',
    width: '',
    steps: [
      { id: 'pre_dedup', label: 'Dedup' },
      { id: 'debate', label: 'Debate' },
    ],
  },
  {
    title: 'Finalize',
    width: '',
    steps: [
      { id: 'threat_synthesizer', label: 'Synthesis' },
      { id: 'dread_validator', label: 'DREAD' },
    ],
  },
] as const

const STEP_NUMBER: Record<string, number> = {
  architecture_parser: 1,
  stride_analyst: 2,
  pasta_analyst: 3,
  attack_tree_analyst: 4,
  pre_dedup: 5,
  debate: 6,
  threat_synthesizer: 7,
  dread_validator: 8,
}

function stateLabel(state: RailState): string {
  if (state === 'done') return 'Done'
  if (state === 'running') return 'Running'
  if (state === 'error') return 'Failed'
  if (state === 'skipped') return 'Skipped'
  return 'Queued'
}

export function ChapterRail({ phases, enabledAnalysts = ['stride', 'pasta', 'attack_tree'] }: ChapterRailProps) {
  return (
    <div
      className="grid overflow-hidden border-y border-[#cacac7] bg-white lg:grid-cols-4 lg:border"
      role="group"
      aria-label="Analysis stages"
    >
      {CHAPTERS.map((chapter, chapterIndex) => (
        <section
          key={chapter.title}
          className={`${chapter.width} border-b border-[#cacac7] p-3 last:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0`}
          aria-labelledby={`chapter-${chapter.title.toLowerCase()}`}
        >
          <h2
            id={`chapter-${chapter.title.toLowerCase()}`}
            className="mb-2 text-center text-xs font-bold uppercase tracking-[0.08em] text-[#666666]"
          >
            {chapter.title}
          </h2>
          <ol
            className="grid"
            style={{ gridTemplateColumns: `repeat(${chapter.steps.length}, minmax(0, 1fr))` }}
            start={chapterIndex === 0 ? 1 : chapterIndex === 1 ? 5 : 7}
          >
            {chapter.steps.map((step, index) => {
              const disabled = 'analyst' in step && !enabledAnalysts.includes(step.analyst)
              const state: RailState = disabled ? 'skipped' : (phases[step.id]?.state ?? 'pending')
              const connectorClass = state === 'done' ? 'after:bg-[#218848]' : 'after:bg-[#cacac7]'
              const nodeClass =
                state === 'done'
                  ? 'border-[#218848] bg-[#218848] text-white'
                  : state === 'running'
                    ? 'border-[#111111] bg-[#111111] text-white ring-4 ring-[#f1f1f0] animate-step-pulse'
                    : state === 'error'
                      ? 'border-[#dd2b37] bg-[#dd2b37] text-white'
                      : 'border-[#cacac7] bg-white text-[#666666]'

              return (
                <li
                  key={step.id}
                  className={`relative min-w-0 text-center ${index < chapter.steps.length - 1 ? `after:absolute after:left-[calc(50%+20px)] after:right-[calc(-50%+20px)] after:top-[17px] after:z-0 after:h-0.5 ${connectorClass}` : ''}`}
                  aria-current={state === 'running' ? 'step' : undefined}
                >
                  <span className={`relative z-10 mx-auto grid h-9 w-9 place-items-center rounded-full border-2 text-xs font-bold ${nodeClass}`}>
                    {STEP_NUMBER[step.id]}
                  </span>
                  <span className="mt-1.5 block truncate text-xs font-semibold text-[#111111]">{step.label}</span>
                  <span
                    className={`mt-0.5 block text-xs ${
                      state === 'done'
                        ? 'text-[#218848]'
                        : state === 'running'
                          ? 'font-semibold text-[#111111]'
                          : state === 'error'
                            ? 'font-semibold text-[#dd2b37]'
                            : 'text-[#666666]'
                    }`}
                  >
                    {stateLabel(state)}
                  </span>
                </li>
              )
            })}
          </ol>
        </section>
      ))}
    </div>
  )
}
