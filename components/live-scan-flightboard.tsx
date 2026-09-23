import type { ReactNode } from 'react'
import Link from 'next/link'
import type { AnalysisConfig } from '@/lib/models/types'
import type { PhaseMap, PipelineProgressEvent, StepState } from '@/lib/ui/progress-phases'
import { deriveFlightboardModel } from '@/lib/ui/scan-flightboard'
import styles from './live-scan-flightboard.module.css'

type LiveScanFlightboardProps = {
  systemName?: string | undefined
  phases: PhaseMap
  events?: PipelineProgressEvent[]
  enabledAnalysts?: AnalysisConfig['enabledAnalysts'] | undefined
  elapsedLabel?: string | undefined
  statusLabel?: string | undefined
  reconnecting?: boolean | undefined
  actions?: ReactNode
}

const STATE_LABEL: Record<StepState, string> = {
  pending: 'Queued', running: 'Running', done: 'Complete', error: 'Warning',
}

function metric(value: number | undefined): string {
  return value == null ? '—' : value.toLocaleString('en-US')
}

function outputLabel(count: number | undefined, singular: string, fallback: string): string {
  return count == null ? fallback : `${metric(count)} ${singular}${count === 1 ? '' : 's'}`
}

function FlowNode({ title, description, state }: {
  title: string
  description: string
  state: StepState
}) {
  return (
    <div className={styles.node} data-state={state} aria-current={state === 'running' ? 'step' : undefined}>
      <h4 className={styles.nodeTitle}>{title}</h4>
      <p className={styles.nodeDescription}>{description}</p>
      <span className={styles.nodeStatus}>
        <span className={styles.stateMark} aria-hidden="true">{state === 'done' ? '✓' : state === 'error' ? '!' : ''}</span>
        {STATE_LABEL[state]}
      </span>
    </div>
  )
}

function FlowColumn({ index, title, state, children }: {
  index: number
  title: string
  state: StepState
  children: ReactNode
}) {
  return (
    <li className={styles.flowColumn} data-state={state}>
      <div className={styles.stageHead}>
        <span className={styles.stageOrb} aria-hidden="true">0{index}</span>
        <div><span className={styles.columnIndex}>Stage 0{index}</span><h3 className={styles.columnTitle}>{title}</h3></div>
      </div>
      <div className={styles.columnBody}>{children}</div>
    </li>
  )
}

export function LiveScanFlightboard({
  systemName,
  phases,
  events = [],
  enabledAnalysts = ['stride', 'pasta', 'attack_tree'],
  elapsedLabel,
  statusLabel = 'Analysis in progress',
  reconnecting = false,
  actions,
}: LiveScanFlightboardProps) {
  const model = deriveFlightboardModel({ phases, events, enabledAnalysts })
  const analystNodes = [
    ...(enabledAnalysts.includes('stride') ? [{ phase: 'stride_analyst', label: 'STRIDE', description: 'Threat categories' }] : []),
    ...(enabledAnalysts.includes('pasta') ? [{ phase: 'pasta_analyst', label: 'PASTA', description: 'Risk scenarios' }] : []),
    ...(enabledAnalysts.includes('attack_tree') ? [{ phase: 'attack_tree_analyst', label: 'Attack trees', description: 'Attack paths' }] : []),
  ]
  // A group reflects its own phases, never the inferred activity of an entire stage.
  const stateFor = (...phaseIds: string[]): StepState => {
    const states = phaseIds.map((phase) => phases[phase]?.state)
    if (states.includes('running')) return 'running'
    if (states.includes('error')) return 'error'
    if (states.every((state) => state === 'done')) return 'done'
    return 'pending'
  }
  const completedCount = (phase: string): number | undefined => phases[phase]?.state === 'done' ? phases[phase]?.count : undefined
  const runningPhases = model.stages.flatMap((stage) => stage.phases).filter((phase) => phases[phase]?.state === 'running')
  const recentActivity = model.activity.filter((item) => item.status !== 'start').slice(0, 3)
  const allFinished = model.stages.every((stage) => stage.state === 'done' || stage.state === 'warning')
  const hasWarnings = model.stages.some((stage) => stage.phases.some((phase) => phases[phase]?.state === 'error'))
  const activityTitle = runningPhases.length > 1
    ? `${runningPhases.length} analysts running`
    : runningPhases.length === 1 ? model.activeTitle : allFinished ? 'Analysis finished' : 'Waiting for the next step'
  const activityMessage = runningPhases.length > 1
    ? 'Examining the architecture in parallel through complementary methods.'
    : runningPhases.length === 1 ? model.activeMessage
      : allFinished ? (hasWarnings ? 'Available results are ready. Review the warnings below.' : 'Results are ready for review.')
        : 'Activity will update as the analysis progresses.'
  const stageStates = [
    stateFor('architecture_parser'),
    stateFor(...analystNodes.map((node) => node.phase)),
    stateFor('pre_dedup'),
    stateFor('debate'),
    stateFor('threat_synthesizer', 'dread_validator'),
  ]
  const activeStep = allFinished ? 5 : Math.max(0, stageStates.findIndex((state) => state === 'running' || state === 'pending')) + 1

  return (
    <section className={styles.flightboard} aria-label="Live threat investigation" data-reconnecting={reconnecting}>
      <header className={styles.header}>
        <div>
          <Link href="/" className={styles.backLink}>← Analysis register</Link>
          <p className={styles.eyebrow}>Threat analysis / live</p>
          <h1 className={styles.title}>Follow the investigation</h1>
          <p className={styles.headerDescription}>
            {systemName ? <><strong>{systemName}</strong><span aria-hidden="true"> · </span></> : null}
            From system context to findings you can review.
          </p>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.runStatus}><span className={styles.liveDot} aria-hidden="true" />{allFinished ? 'Analysis finished' : statusLabel}</span>
          {reconnecting ? <span className={styles.reconnecting} role="status">Reconnecting…</span> : null}
          {actions}
        </div>
      </header>
      <div className={styles.activeStrip} role="status">
        <span className={styles.activeIndex} data-running={!allFinished && !reconnecting} aria-hidden="true">0{activeStep}</span>
        <div className={styles.activeCopy}>
          <span className={styles.activeLabel}>{allFinished ? 'Investigation complete' : `Processing / 0${activeStep} of 05`}</span>
          <strong>{activityTitle}</strong>
          <span>{hasWarnings ? 'Some stages degraded; inspect warnings and available outputs.' : activityMessage}</span>
        </div>
        {elapsedLabel ? <span className={styles.elapsed} aria-label={`Elapsed time: ${elapsedLabel}`}>{elapsedLabel} elapsed</span> : null}
      </div>

      <div className={styles.body}>
        <div className={styles.mapPane}>
          <div className={styles.mapHeading}><span>Signal path</span><span>Each handoff follows the real pipeline</span></div>
          <ol className={styles.flow} aria-label="Analysis workflow">
            <FlowColumn index={1} title="Architecture" state={stageStates[0]!}>
              <FlowNode title="System map" description="Components & boundaries" state={stateFor('architecture_parser')} />
            </FlowColumn>
            <FlowColumn index={2} title="Analysis" state={stageStates[1]!}>
              {analystNodes.length > 0 ? (
                <ul className={styles.analystStack} aria-label="Parallel analysis methods">
                  {analystNodes.map((node) => (
                    <li className={styles.analystBranch} key={node.phase}>
                      <FlowNode title={node.label} description={outputLabel(completedCount(node.phase), 'signal', node.description)} state={stateFor(node.phase)} />
                    </li>
                  ))}
                </ul>
              ) : <p className={styles.emptyMethods}>No methods selected</p>}
            </FlowColumn>
            <FlowColumn index={3} title="Consolidation" state={stageStates[2]!}>
              <FlowNode title="Candidates" description={outputLabel(model.distinctCandidates, 'candidate', 'Merge overlapping signals')} state={stateFor('pre_dedup')} />
            </FlowColumn>
            <FlowColumn index={4} title="Challenge" state={stageStates[3]!}>
              <FlowNode title="Red / Blue" description="Challenge the evidence" state={stateFor('debate')} />
            </FlowColumn>
            <FlowColumn index={5} title="Results" state={stageStates[4]!}>
              <div className={styles.resultStack}>
                <FlowNode title="Findings" description={outputLabel(model.validatedFindings, 'finding', 'Synthesize & validate')} state={stateFor('threat_synthesizer', 'dread_validator')} />
              </div>
            </FlowColumn>
          </ol>
          <div className={styles.mapFooter}>
            <p className={styles.flowNote}>Outputs appear when a stage checkpoints. They remain subject to human review.</p>
            <ul className={styles.legend} aria-label="Workflow states">
              {(['done', 'running', 'pending', 'error'] as const).map((state) => (
                <li key={state} data-state={state}>
                  <span className={styles.stateMark} aria-hidden="true">{state === 'done' ? '✓' : state === 'error' ? '!' : ''}</span>
                  {STATE_LABEL[state]}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <aside className={styles.activityPane} aria-label="Live activity">
          <dl className={styles.metrics} aria-label="Confirmed results">
            <div className={styles.metric}><dt>Analyst signals</dt><dd>{metric(model.analystSignals)}</dd></div>
            <div className={styles.metric}><dt>Distinct candidates</dt><dd>{metric(model.distinctCandidates)}</dd></div>
            <div className={styles.metric}><dt>Validated findings</dt><dd>{metric(model.validatedFindings)}</dd></div>
          </dl>
          <div className={styles.recentActivity}>
            <h3 className={styles.activityTitle}>Recent milestones</h3>
            {recentActivity.length > 0 ? (
              <ol className={styles.activityList}>
                {recentActivity.map((item) => (
                  <li key={item.key} className={styles.activityItem} data-state={item.status === 'error' ? 'error' : 'done'}>
                    <span className={styles.stateMark} aria-hidden="true">{item.status === 'error' ? '!' : '✓'}</span>
                    <div>
                      <p className={styles.activityName}>{item.title}{item.status === 'error' ? ' · Warning' : ''}</p>
                      <p className={styles.activityMessage}>{item.message}</p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : <p className={styles.emptyActivity}>Completed steps and confirmed results will appear here.</p>}
          </div>
        </aside>
      </div>
    </section>
  )
}
