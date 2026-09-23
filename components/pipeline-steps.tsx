'use client'

import type { PhaseMap, StepState } from '@/lib/ui/progress-phases'

export type { PhaseMap, StepState } from '@/lib/ui/progress-phases'

export const PHASE_ORDER = [
  'architecture_parser',
  'stride_analyst',
  'pasta_analyst',
  'attack_tree_analyst',
  'pre_dedup',
  'debate',
  'threat_synthesizer',
  'dread_validator',
] as const

const PHASE_SHORT: Record<string, string> = {
  architecture_parser: 'Parse',
  stride_analyst:      'STRIDE',
  pasta_analyst:       'PASTA',
  attack_tree_analyst: 'Trees',
  pre_dedup:           'Dedup',
  debate:              'Debate',
  threat_synthesizer:  'Synth',
  dread_validator:     'DREAD',
}

export const PHASE_LABEL: Record<string, string> = {
  architecture_parser: 'Parsing architecture',
  stride_analyst:      'STRIDE analysis',
  pasta_analyst:       'PASTA analysis',
  attack_tree_analyst: 'Attack Tree analysis',
  pre_dedup:           'Deduplicating threats',
  debate:              'Red/Blue team debate',
  threat_synthesizer:  'Synthesizing threats',
  dread_validator:     'DREAD scoring & validation',
}

type PipelineStepsProps = {
  phases: PhaseMap
  compact?: boolean
}

export function PipelineSteps({ phases, compact = false }: PipelineStepsProps) {
  const activePhase = PHASE_ORDER.find((k) => phases[k]?.state === 'running')

  return (
    <div className="space-y-4">
      {/* Horizontal stepper */}
      <div className="relative">
        {/* Mobile: compact label row */}
        <div className="flex items-center justify-between sm:hidden px-1 mb-2">
          {activePhase && (
            <span className="text-xs text-primary font-medium">
              {PHASE_LABEL[activePhase]}…
            </span>
          )}
        </div>

        {/* Desktop: full horizontal stepper */}
        <div className={`hidden sm:flex items-start justify-between ${compact ? 'gap-0' : 'gap-0'}`}>
          {PHASE_ORDER.map((key, idx) => {
            const state: StepState = phases[key]?.state ?? 'pending'
            const isLast = idx === PHASE_ORDER.length - 1
            const prevPhase = idx > 0 ? PHASE_ORDER[idx - 1] : undefined
            const prevState: StepState = prevPhase
              ? (phases[prevPhase]?.state ?? 'pending')
              : 'pending'

            return (
              <div key={key} className="flex items-center flex-1">
                {/* Step */}
                <div className="flex flex-col items-center flex-shrink-0">
                  <div
                    className={[
                      'w-8 h-8 rounded-full flex items-center justify-center transition-all duration-300 text-xs font-bold',
                      state === 'done'
                        ? 'bg-primary text-primary-content'
                        : state === 'error'
                        ? 'border-2 border-red-500 bg-red-50 text-red-700'
                        : state === 'running'
                        ? 'border-2 border-primary bg-primary/10 text-primary animate-step-pulse'
                        : 'border-2 border-base-300 bg-base-100 text-base-content/30',
                    ].join(' ')}
                  >
                    {state === 'done' && (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                    {state === 'running' && (
                      <span className="loading loading-spinner loading-xs" />
                    )}
                    {state === 'error' && <span aria-label="Failed">!</span>}
                    {state === 'pending' && (
                      <span className="text-xs">{idx + 1}</span>
                    )}
                  </div>
                  <span
                    className={[
                      'mt-1.5 text-xs font-medium whitespace-nowrap',
                      state === 'done'    ? 'text-primary' :
                      state === 'error'   ? 'text-red-700' :
                      state === 'running' ? 'text-primary' :
                                            'text-base-content/35',
                    ].join(' ')}
                  >
                    {PHASE_SHORT[key]}
                  </span>
                  {phases[key]?.count != null && state === 'done' && (
                    <span className="mt-0.5 font-mono text-xs text-base-content/40">
                      {phases[key].count}
                    </span>
                  )}
                </div>

                {/* Connector */}
                {!isLast && (
                  <div className="flex-1 h-0.5 mx-1 mb-5 transition-all duration-500"
                    style={{
                      background: state === 'done'
                        ? '#218848'
                        : prevState === 'done' && state === 'running'
                        ? '#218848'
                        : '#cacac7',
                    }}
                  />
                )}
              </div>
            )
          })}
        </div>

        {/* Mobile: step dots row (compact) */}
        <div className="flex items-center gap-1 sm:hidden">
          {PHASE_ORDER.map((key, idx) => {
            const state: StepState = phases[key]?.state ?? 'pending'
            const isLast = idx === PHASE_ORDER.length - 1
            return (
              <div key={key} className="flex items-center flex-1">
                <div className={[
                  'w-2.5 h-2.5 rounded-full flex-shrink-0',
                  state === 'done'    ? 'bg-primary' :
                  state === 'error'   ? 'bg-red-500' :
                  state === 'running' ? 'bg-primary animate-step-pulse' :
                                        'bg-base-300',
                ].join(' ')} />
                {!isLast && (
                  <div className="flex-1 h-px"
                    style={{ background: state === 'done' ? '#218848' : '#cacac7' }}
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
