'use client'

import { useState, useRef, useEffect, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { QuestionMarkCircleIcon } from '@heroicons/react/24/outline'
import setupStyles from './analyze-v2.module.css'
import { ModelSelector } from '@/components/model-selector'
import { LiveScanFlightboard } from '@/components/live-scan-flightboard'
import { SystemPicker } from '@/components/system-picker'
import { ProjectWorkspace, type ProjectSummary } from '@/components/project-workspace'
import type { AnalysisConfig } from '@/lib/models/types'
import {
  ANALYSIS_DRAFT_STORAGE_KEY,
  parseAnalysisDraft,
  type AnalysisDraft,
} from '@/lib/runs/analysis-draft'
import type { RunInputBundle } from '@/lib/runs/input-bundle'
import { formatFullDate, formatInteger } from '@/lib/ui/format'
import { RagRunSettings } from '@/components/rag-run-settings'
import { RagPreflightBanner, useServiceHealth } from '@/components/service-health'
import { PROVIDER_METADATA, isLLMProvider } from '@/lib/llm/providers'
import {
  getCompatibleInferenceProfiles,
  getDefaultInferenceProfile,
  isInferenceProfileId,
  normalizeAllowedProfiles,
  normalizeAllowedProviders,
} from '@/lib/llm/execution-profiles'

type RunState = 'idle' | 'uploading' | 'running' | 'done' | 'error'

type PreviousRunSummary = {
  id: string
  systemName: string | null
  status: string
  createdAt: string
}

type UploadedInput = {
  upload_id: string
  original_name: string
  expires_at: string
  size: number
  extractedLength: number
}

const ANALYST_MODES = [
  {
    id: 'hybrid' as const,
    label: 'Hybrid (Recommended)',
    option: 'Hybrid (Recommended) - STRIDE then PASTA || trees',
    description: 'STRIDE establishes broad coverage first, then PASTA and attack trees enrich it in parallel. Recommended for the best quality, time and cost balance.',
  },
  {
    id: 'parallel' as const,
    label: 'Parallel',
    option: 'Parallel - all analysts together',
    description: 'Runs all analysts at the same time. Recommended when speed matters and the selected provider supports concurrent requests; it can produce more overlap.',
  },
  {
    id: 'cascade' as const,
    label: 'Cascade',
    option: 'Cascade - STRIDE to PASTA to trees',
    description: 'Each analyst receives the previous analyst output. Recommended for focused high-risk reviews where deeper sequential reasoning is worth the extra latency.',
  },
] as const

const DEFAULT_ANALYSIS_CONFIG: Partial<AnalysisConfig> = {
  provider: 'ollama',
  allowedProviders: ['ollama'],
  executionProfile: 'local_efficient',
  allowedProfiles: ['local_efficient'],
  // Omitted model IDs use server defaults; saved runs retain explicit selections.
  enabledAnalysts: ['stride', 'pasta', 'attack_tree'],
  executionMode: 'hybrid',
  maxDebateRounds: 2,
  targetThreats: 15,
  useRag: true,
}

function normalizePrefillConfig(value: Partial<AnalysisConfig> | undefined): Partial<AnalysisConfig> {
  const provider = isLLMProvider(value?.provider) ? value.provider : 'ollama'
  const compatible = getCompatibleInferenceProfiles(provider)
  const requestedProfile = isInferenceProfileId(value?.executionProfile) ? value.executionProfile : null
  const executionProfile = requestedProfile && compatible.includes(requestedProfile)
    ? requestedProfile
    : getDefaultInferenceProfile(provider)
  return {
    ...DEFAULT_ANALYSIS_CONFIG,
    ...value,
    provider,
    executionProfile,
    allowedProviders: normalizeAllowedProviders(value?.allowedProviders, provider),
    allowedProfiles: normalizeAllowedProfiles(value?.allowedProfiles, executionProfile)
      .filter((profile) => compatible.includes(profile)),
  }
}

function AnalystModeHelp({ mode }: { mode: (typeof ANALYST_MODES)[number] }) {
  return (
    <span className="group/mode-help relative inline-flex">
      <button
        type="button"
        aria-describedby="analyst-mode-help"
        aria-label={`About ${mode.label} analyst mode`}
        className="grid h-6 w-6 place-items-center text-[#666666] hover:text-[#111111]"
      >
        <QuestionMarkCircleIcon className="h-4 w-4" aria-hidden="true" />
      </button>
      <span
        id="analyst-mode-help"
        role="tooltip"
        className="pointer-events-none absolute left-0 top-7 z-30 hidden w-72 border border-[#cacac7] bg-[#111111] p-3 text-left text-[11px] font-normal leading-5 text-white shadow-xl group-hover/mode-help:block group-focus-within/mode-help:block"
      >
        <strong className="block text-xs">{mode.label}</strong>
        <span className="mt-1 block text-[#dce6e0]">{mode.description}</span>
      </span>
    </span>
  )
}

export default function AnalyzePage() {
  return (
    <Suspense fallback={<div className="ledger-panel p-6 text-sm text-slate-500">Loading form…</div>}>
      <AnalyzePageContent />
    </Suspense>
  )
}

function AnalyzePageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const fileRef = useRef<HTMLInputElement>(null)
  
  // Form and analysis states
  const [systemName, setSystemName] = useState('')
  const [input, setInput] = useState('')
  const [inputType, setInputType] = useState<'text' | 'file'>('text')
  const [config, setConfig] = useState<Partial<AnalysisConfig>>(DEFAULT_ANALYSIS_CONFIG)
  const [runState, setRunState] = useState<RunState>('idle')
  const [error, setError] = useState('')
  const [systemId, setSystemId] = useState<string | undefined>()
  const [reviewMemory, setReviewMemory] = useState<{ systemId: string; projectId: string | undefined; count: number | undefined } | null>(null)
  const [previousRuns, setPreviousRuns] = useState<PreviousRunSummary[]>([])
  const [selectedPreviousRun, setSelectedPreviousRun] = useState('')
  const [isImportingRun, setIsImportingRun] = useState(false)
  const [draftReady, setDraftReady] = useState(false)
  const [draftRestored, setDraftRestored] = useState(false)
  const [draftWarning, setDraftWarning] = useState('')
  const latestDraftRef = useRef<AnalysisDraft | null>(null)
  const [activeProject, setActiveProject] = useState<ProjectSummary | null>(null)
  const [uploadedInputs, setUploadedInputs] = useState<UploadedInput[]>([])
  const [workspaceReady, setWorkspaceReady] = useState<boolean | null>(null)
  const activeProjectIdRef = useRef<string | null | undefined>(undefined)
  const installationDefaultApplied = useRef(false)
  const health = useServiceHealth()
  const selectedPreviousRunAvailable = previousRuns.some((run) => run.id === selectedPreviousRun)

  useEffect(() => {
    if (!systemId || workspaceReady !== true) return
    const controller = new AbortController()
    void fetch(`/api/v1/projects/learning?systemId=${encodeURIComponent(systemId)}`, {
      cache: 'no-store', signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error('Review memory unavailable')
      const body = await response.json() as { data?: { examplesForNextRun?: number } }
      setReviewMemory({ systemId, projectId: activeProject?.id, count: body.data?.examplesForNextRun })
    }).catch(() => { if (!controller.signal.aborted) setReviewMemory({ systemId, projectId: activeProject?.id, count: undefined }) })
    return () => controller.abort()
  }, [systemId, activeProject?.id, workspaceReady])

  const reviewMemoryCount = reviewMemory && reviewMemory.systemId === systemId && reviewMemory.projectId === activeProject?.id
    ? reviewMemory.count : null

  const handleActiveProjectChange = useCallback((project: ProjectSummary | null, requiresProject: boolean) => {
    const nextProjectId = project?.id ?? null
    const previousProjectId = activeProjectIdRef.current
    if (previousProjectId !== nextProjectId) {
      setPreviousRuns([])
      setSelectedPreviousRun('')
      if (previousProjectId !== undefined) setSystemId(undefined)
      if (previousProjectId !== undefined) setUploadedInputs([])
    }
    activeProjectIdRef.current = nextProjectId
    setActiveProject(project)
    setWorkspaceReady(!requiresProject)
    setError('')
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/v1/projects/active', { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok
        ? response.json()
        : Promise.reject(new Error('Project workspace status could not be loaded')))
      .then((body: { data: ProjectSummary | null; requiresProject: boolean }) => {
        handleActiveProjectChange(body.data, body.requiresProject)
      })
      .catch((workspaceError: unknown) => {
        if (workspaceError instanceof DOMException && workspaceError.name === 'AbortError') return
        setWorkspaceReady(false)
        setError(workspaceError instanceof Error
          ? workspaceError.message
          : 'Project workspace status could not be loaded')
      })
    return () => controller.abort()
  }, [handleActiveProjectChange])

  /* eslint-disable react-hooks/set-state-in-effect -- mount-only prefill from
     URL params + browser storage; effect avoids SSR/hydration mismatch. */
  useEffect(() => {
    const rerunFrom = searchParams.get('rerunFrom')
    let cancelled = false
    let controller: AbortController | null = null
    let draft: AnalysisDraft | null = null
    try {
      draft = parseAnalysisDraft(sessionStorage.getItem(ANALYSIS_DRAFT_STORAGE_KEY))
    } catch {
      /* Browser storage can be unavailable under restrictive privacy settings. */
    }

    // A rerun URL identifies the authoritative saved inputs. An unrelated tab draft
    // must not leave the new analysis with only the system name prefilled.
    if (rerunFrom && !(draft?.sourceRunId === rerunFrom && draft.input.trim())) {
      controller = new AbortController()
      setIsImportingRun(true)
      setError('')
      void fetch(`/api/v1/results/${encodeURIComponent(rerunFrom)}?format=inputs`, {
        cache: 'no-store', signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok) throw new Error('Previous run inputs could not be loaded. Select the run again or add a description.')
        const bundle = await response.json() as RunInputBundle
        if (!bundle.effectiveInput?.trim()) throw new Error('This run has no saved input to reuse. Add a system description or upload a document.')
        if (cancelled) return
        setSystemName(bundle.systemName)
        setSystemId(bundle.systemId ?? undefined)
        setInput(bundle.effectiveInput)
        setInputType('text')
        setSelectedPreviousRun(rerunFrom)
        if (bundle.executionConfig) setConfig(normalizePrefillConfig(bundle.executionConfig))
      }).catch((importError: unknown) => {
        if (cancelled) return
        setError(importError instanceof Error ? importError.message : 'Previous run inputs could not be loaded')
      }).finally(() => {
        if (cancelled) return
        setIsImportingRun(false)
        setDraftReady(true)
      })
      return () => { cancelled = true; controller?.abort() }
    }

    if (draft) {
      setSystemName(draft.systemName)
      setSystemId(draft.systemId)
      setInput(draft.input)
      setInputType(draft.inputType)
      setConfig(normalizePrefillConfig(draft.config))
      setSelectedPreviousRun(draft.selectedPreviousRun)
      setDraftRestored(true)
    }

    const fromQueryName = searchParams.get('systemName')
    const fromQueryId = searchParams.get('systemId')
    if (!rerunFrom && fromQueryName) setSystemName(fromQueryName)
    if (!rerunFrom && fromQueryId) setSystemId(fromQueryId)
    setDraftReady(true)
  }, [searchParams])
  /* eslint-enable react-hooks/set-state-in-effect */

  /* eslint-disable react-hooks/set-state-in-effect -- adopt the installer preference
     after the asynchronous health response arrives, without replacing a rerun. */
  useEffect(() => {
    if (!draftReady || !health?.llmProvider || installationDefaultApplied.current) return
    installationDefaultApplied.current = true
    if (searchParams.get('rerunFrom')) return
    const provider = isLLMProvider(health.llmProvider) ? health.llmProvider : 'ollama'
    if (provider === 'ollama' && health.ragDefaultEnabled !== false) return
    setConfig((current) => {
      if (current.provider !== 'ollama') return current
      const executionProfile = getDefaultInferenceProfile(provider)
      const next: Partial<AnalysisConfig> = {
        ...current,
        provider,
        allowedProviders: [provider],
        executionProfile,
        allowedProfiles: [executionProfile],
        useRag: health.ragDefaultEnabled !== false,
      }
      delete next.quickModel
      delete next.deepModel
      return next
    })
  }, [draftReady, health?.llmProvider, health?.ragDefaultEnabled, searchParams])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!draftReady || runState === 'done') return

    const sourceRunId = selectedPreviousRun || searchParams.get('rerunFrom')
    const draft: AnalysisDraft = {
      schemaVersion: 1,
      systemName,
      ...(systemId ? { systemId } : {}),
      input,
      inputType,
      config,
      selectedPreviousRun,
      ...(sourceRunId ? { sourceRunId } : {}),
    }
    latestDraftRef.current = draft

    const persistDraft = () => {
      try {
        sessionStorage.setItem(ANALYSIS_DRAFT_STORAGE_KEY, JSON.stringify(draft))
        setDraftWarning('')
      } catch {
        setDraftWarning('This draft is too large for browser storage. Keep this page open until the analysis starts.')
      }
    }
    const timeout = window.setTimeout(persistDraft, 250)
    return () => window.clearTimeout(timeout)
  }, [config, draftReady, input, inputType, runState, searchParams, selectedPreviousRun, systemId, systemName])

  useEffect(() => () => {
    if (!latestDraftRef.current) return
    try {
      sessionStorage.setItem(ANALYSIS_DRAFT_STORAGE_KEY, JSON.stringify(latestDraftRef.current))
    } catch {
      /* The visible quota warning was already raised by the autosave effect. */
    }
  }, [])

  useEffect(() => {
    if (workspaceReady !== true) return
    const controller = new AbortController()
    fetch('/api/v1/results?limit=50&status=completed', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Unable to list runs')))
      .then((body: { data?: PreviousRunSummary[] }) => setPreviousRuns(body.data ?? []))
      .catch((fetchError: unknown) => {
        if (!(fetchError instanceof DOMException && fetchError.name === 'AbortError')) {
          setPreviousRuns([])
        }
      })
    return () => controller.abort()
  }, [activeProject?.id, workspaceReady])

  async function handleImportRun(runId: string) {
    setSelectedPreviousRun(runId)
    if (!runId) return
    setIsImportingRun(true)
    setError('')
    try {
      const response = await fetch(`/api/v1/results/${encodeURIComponent(runId)}?format=inputs`, {
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('Previous run inputs could not be loaded')
      const bundle = await response.json() as RunInputBundle
      if (!bundle.effectiveInput?.trim()) throw new Error('This run has no saved input to reuse. Add a system description or upload a document.')
      setSystemName(bundle.systemName)
      setSystemId(bundle.systemId ?? undefined)
      setInput(bundle.effectiveInput)
      setInputType('text')
      if (bundle.executionConfig) setConfig(normalizePrefillConfig(bundle.executionConfig))
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Previous run inputs could not be loaded')
    } finally {
      setIsImportingRun(false)
    }
  }

  async function handleFileUpload(file: File) {
    setRunState('uploading')
    setError('')
    const form = new FormData()
    form.append('file', file)
    try {
      const res = await fetch('/api/v1/upload', { method: 'POST', body: form })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'File upload failed')
      setUploadedInputs((current) => [
        ...current.filter((upload) => upload.upload_id !== data.upload_id),
        {
          upload_id: data.upload_id,
          original_name: data.original_name,
          expires_at: data.expires_at,
          size: data.size,
          extractedLength: data.extractedLength,
        },
      ])
      setInputType('file')
      setRunState('idle')
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'File upload failed')
      setRunState('error')
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (workspaceReady !== true) {
      setError('Select or create a local project before starting an analysis.')
      return
    }
    if (isImportingRun || !draftReady) {
      setError('Wait for the previous run inputs to finish loading.')
      return
    }
    if (!systemName.trim()) {
      setError('Enter a system name. You can keep the previous name when scanning the same system again.')
      return
    }
    if (!input.trim() && uploadedInputs.length === 0) {
      setError('Add a system description or upload a document. To reuse a previous scan, select it above.')
      return
    }
    if (config.useRag !== false && health?.rag && !health.rag.usable) {
      setError(
        health.rag.reason
          || 'Knowledge retrieval is not ready. Fix RAG before running this scan, or turn it off if you want an architecture-only run.',
      )
      return
    }
    setError('')
    setRunState('running')
    const normalizedConfig = normalizePrefillConfig(config)

    try {
      const res = await fetch('/api/v1/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemName,
          systemId,
          input,
          upload_ids: uploadedInputs.map((upload) => upload.upload_id),
          inputType,
          config: {
            provider: normalizedConfig.provider,
            allowedProviders: normalizedConfig.allowedProviders,
            executionProfile: normalizedConfig.executionProfile,
            allowedProfiles: normalizedConfig.allowedProfiles,
            quickModel: normalizedConfig.quickModel,
            deepModel: normalizedConfig.deepModel,
            enabledAnalysts: normalizedConfig.enabledAnalysts,
            executionMode: normalizedConfig.executionMode,
            maxDebateRounds: normalizedConfig.maxDebateRounds,
            targetThreats: normalizedConfig.targetThreats,
            requireEvidenceForHighPriority: true,
            useRag: normalizedConfig.useRag !== false,
          },
        }),
      })

      if (!res.ok) {
        // Never surface the raw response body — it may contain HTML or stack traces.
        const fallback = `Analysis request failed (status ${res.status})`
        let message: string | null = null
        try {
          const body = await res.json()
          if (typeof body?.error === 'string') message = body.error.slice(0, 200)
        } catch {
          /* non-JSON error body — use the generic fallback */
        }
        throw new Error(message ?? fallback)
      }

      // POST /analyze now always returns 202 Accepted with analysis ID
      const data = await res.json()
      try {
        sessionStorage.removeItem(ANALYSIS_DRAFT_STORAGE_KEY)
      } catch {
        /* Storage cleanup must never turn an accepted analysis into a UI error. */
      }
      latestDraftRef.current = null
      setRunState('done')
      // Keep the launch state visible until the results page is ready.
      router.push(`/results/${data.analysisId}/live`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setRunState('error')
    }
  }

  const isRunning = runState === 'running' || runState === 'done'
  const workspaceBlocked = workspaceReady !== true
  const selectedProvider = config.provider ?? 'ollama'
  const selectedProfile = config.executionProfile ?? 'local_efficient'
  const selectedAnalystMode = ANALYST_MODES.find(
    (mode) => mode.id === (config.executionMode ?? 'hybrid'),
  ) ?? ANALYST_MODES[0]
  const providerLabel = PROVIDER_METADATA[selectedProvider].label
  const profileLabel = selectedProfile === 'local_efficient'
    ? 'Local Efficient'
    : selectedProfile === 'provider_optimized'
      ? 'Provider Optimized'
      : selectedProfile === 'provider_full_power'
        ? selectedProvider === 'ollama' ? 'Local Full Power' : 'Provider Full Power'
        : selectedProvider === 'ollama' ? 'Adaptive Local' : 'Adaptive Value'
  const recommendation = selectedProvider === 'ollama'
    ? 'Best privacy boundary for critical or sensitive systems. With verified ZDR, cloud is viable; for testing or non-sensitive systems, Kimi offers strong cost-to-quality.'
    : selectedProvider === 'kimi'
      ? 'Strong cost-to-quality option for testing and non-sensitive systems. For sensitive data, use cloud inference only with a verified ZDR agreement.'
      : 'Cloud inference is recommended for sensitive systems only after verifying a ZDR agreement, data handling terms and the required region.'

  return (
    <div className={`${setupStyles.page} mx-auto max-w-5xl space-y-4`}>
      {/* Header */}
      <div className={setupStyles.header}>
        <div className={setupStyles.headerCopy}>
          <p className={setupStyles.eyebrow}>New assessment / 02</p>
          <h1>Run a threat analysis<span>.</span></h1>
          <p>Add the system context, then choose one inference provider and one execution profile for the complete run.</p>
        </div>
        <details className={setupStyles.providerHint}><summary>Provider guidance · {providerLabel}</summary><p>{recommendation}</p></details>
      </div>

      <div className="space-y-3">
        {workspaceReady === false ? (
          <div role="status" className="border border-[#cacac7] bg-[#f1f1f0] px-4 py-3 text-sm leading-6 text-[#5d4620]">
            <strong className="text-[#111111]">Choose where this analysis will live.</strong>{' '}
            Create a local project or select an existing one below. It becomes active immediately—no database configuration is required.
          </div>
        ) : activeProject ? (
          <div role="status" className={setupStyles.projectStatus}>
            Active project: <strong>{activeProject.name}</strong>
          </div>
        ) : null}
        {activeProject ? <details className="workbench-panel"><summary className="cursor-pointer px-4 py-3 text-xs font-semibold">Switch or create a project</summary><ProjectWorkspace onActiveProjectChange={handleActiveProjectChange} /></details> : <ProjectWorkspace onActiveProjectChange={handleActiveProjectChange} />}
      </div>

      <RagPreflightBanner
        health={health}
        ragRequested={config.useRag !== false}
        onTurnOffRag={() => setConfig((current) => ({ ...current, useRag: false }))}
      />

      {draftReady && (
        <div
          role="status"
          className={`border px-4 py-3 text-xs leading-5 ${draftWarning
            ? 'border-[#e5a3a3] bg-[#fff5f5] text-[#a11119]'
            : 'border-[#cacac7] bg-[#fcfcfb] text-[#555555]'}`}
        >
          {draftWarning || (draftRestored
            ? 'Draft restored. Your unfinished Run Analysis form was recovered from this browser tab.'
            : 'This form is saved automatically while it is unfinished and will survive navigation and reloads in this browser tab.')}
        </div>
      )}

      {/* Live pipeline — visible while running */}
      {isRunning && (
        <>
          <LiveScanFlightboard
            phases={{ architecture_parser: { state: 'running' } }}
            enabledAnalysts={config.enabledAnalysts}
            statusLabel={runState === 'done' ? 'Opening live analysis' : 'Starting analysis'}
          />
          {runState === 'done' && <p role="status" className="text-sm text-[#555555]">The run was accepted. Opening its live progress now…</p>}
        </>
      )}

      <form
        onSubmit={handleSubmit}
        data-disabled={isRunning || runState === 'uploading' || workspaceBlocked}
        className={`space-y-5 ${isRunning ? 'opacity-40 pointer-events-none' : ''}`}
      >
        {/* System name */}
        <div className={`${setupStyles.contextPanel} workbench-panel space-y-5 p-5 sm:p-6`}>
          <div className={setupStyles.contextHeading}><div><p>01 / System context</p><h2>Describe the system.</h2></div><span>Good evidence starts with clear boundaries and known unknowns.</span></div>
          <details className="border border-[#e4e4e2] bg-[#fcfcfb] p-4"><summary className="cursor-pointer text-xs font-semibold">Reuse a previous run</summary><div className="mt-3">
            <label htmlFor="previous-run" className="block text-sm font-semibold text-[#333333]">
              Import from a previous run
            </label>
            <p className="mt-1 text-xs leading-5 text-[#666666]">
              Reuse the effective prompt, extracted document context and recorded routing as a new independent analysis.
            </p>
            <select
              id="previous-run"
              value={selectedPreviousRunAvailable ? selectedPreviousRun : ''}
              disabled={isImportingRun || previousRuns.length === 0}
              onChange={(event) => void handleImportRun(event.target.value)}
              className="mt-3 min-h-11 w-full border border-[#cacac7] bg-white px-3 text-sm text-[#333333] outline-none focus:border-[#111111] focus:ring-2 focus:ring-[#111111]/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">
                {previousRuns.length === 0 ? 'No completed runs available' : 'Select a completed run...'}
              </option>
              {previousRuns.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.systemName ?? 'Untitled analysis'} · {formatFullDate(run.createdAt)}
                </option>
              ))}
            </select>
            {isImportingRun ? <p className="mt-2 text-xs text-[#666666]" role="status">Importing run inputs...</p> : null}
          </div></details>
          {workspaceReady === true ? (
            <SystemPicker
              key={activeProject?.id ?? 'shared-database'}
              systemName={systemName}
              systemId={systemId}
              disabled={isRunning || runState === 'uploading'}
              onSelect={({ systemName: name, systemId: id }) => {
                setSystemName(name)
                setSystemId(id)
              }}
            />
          ) : (
            <div className="border border-[#e4e4e2] bg-[#fcfcfb] px-4 py-3 text-sm text-[#666666]">
              System history becomes available after a project is active.
            </div>
          )}
          <div>
            <label htmlFor="system-name" className="block text-sm font-medium text-slate-700 mb-1.5">System Name</label>
            <input
              id="system-name"
              type="text"
              className="min-h-11 w-full border border-[#cacac7] bg-white px-3.5 text-sm text-slate-900 outline-none focus:border-[#111111] focus:ring-2 focus:ring-[#111111]/20"
              placeholder="e.g. Payment Gateway API, Customer Portal"
              value={systemName}
              onChange={(e) => {
                setSystemName(e.target.value)
                // Typing a different name detaches from a picked system
                if (systemId) setSystemId(undefined)
              }}
              required
            />
            <p className="mt-1.5 text-xs text-[#666666]">Keep the same name for another scan of this system. Choose a new name only if it is a different system.</p>
          </div>

          <div>
            <label htmlFor="system-description" className="block text-sm font-medium text-slate-700 mb-1.5">System Description</label>
            <details className="mb-3 border-l-2 border-[#111111] bg-[#fcfcfb] px-3 py-2 text-xs leading-5 text-[#555555]"><summary className="cursor-pointer font-semibold">What to include for a useful threat model</summary><ul className="mt-2 list-disc space-y-1 pl-5"><li>Assets and sensitive data worth protecting.</li><li>Components, entry points, data flows and trust boundaries.</li><li>Existing controls, with what is documented versus only planned.</li><li>Deployment environment and dependencies.</li><li>Unknowns and assumptions the reviewer should verify.</li></ul></details>

            {/* Tab selector */}
            <div className="mb-2 flex w-fit gap-1 border border-[#cacac7] bg-[#fcfcfb] p-1" role="tablist" aria-label="Input type">
              <button
                type="button"
                role="tab"
                id="input-tab-text"
                aria-controls="system-description"
                aria-selected={inputType === 'text'}
                tabIndex={inputType === 'text' ? 0 : -1}
                onClick={() => setInputType('text')}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight') {
                    event.preventDefault()
                    setInputType('file')
                    document.getElementById('input-tab-file')?.focus()
                  }
                }}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${inputType === 'text' ? 'bg-white text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
              >
                Text
              </button>
              <button
                type="button"
                role="tab"
                id="input-tab-file"
                aria-controls="system-description"
                aria-selected={inputType === 'file'}
                tabIndex={inputType === 'file' ? 0 : -1}
                onClick={() => { setInputType('file'); fileRef.current?.click() }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft') {
                    event.preventDefault()
                    setInputType('text')
                    document.getElementById('input-tab-text')?.focus()
                  }
                }}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${inputType === 'file' ? 'bg-white text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
              >
                Upload File
              </button>
            </div>

            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept=".txt,.md,.pdf,.json,.yaml,.yml"
              aria-label="Upload architecture document"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileUpload(f) }}
            />

            <textarea
              id="system-description"
              role="tabpanel"
              aria-labelledby={inputType === 'text' ? 'input-tab-text' : 'input-tab-file'}
              aria-label="System description text"
              className="h-56 w-full resize-y border border-[#cacac7] bg-white px-3.5 py-3 font-mono text-sm text-slate-900 outline-none placeholder:text-slate-600 focus:border-[#111111] focus:ring-2 focus:ring-[#111111]/20"
              placeholder={`Paste your RFC, architecture description, or Mermaid diagram here…

Example:
REST API backend in Node.js/Fastify + React frontend.
JWT authentication stored in PostgreSQL.
Stripe for payments, Sendgrid for email.
Architecture: API Gateway → Auth → Business Logic → PostgreSQL + Redis.
Deployed on AWS ECS with ALB.`}
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            {input && (
              <p className="text-xs text-slate-600 mt-1">{formatInteger(input.length)} characters</p>
            )}
            {uploadedInputs.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-[#555555]" aria-label="Uploaded documents">
                {uploadedInputs.map((upload) => (
                  <li key={upload.upload_id} className="flex items-center justify-between border border-[#cacac7] bg-[#fcfcfb] px-3 py-2">
                    <span>{upload.original_name} · {formatInteger(upload.size)} bytes · {formatInteger(upload.extractedLength)} text characters extracted and available</span>
                    <button type="button" onClick={() => setUploadedInputs((items) => items.filter((item) => item.upload_id !== upload.upload_id))} className="font-semibold text-red-700">Remove</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {(isRunning || runState === 'uploading') && (
          <p className="sr-only" role="status">
            {runState === 'uploading' ? 'Uploading input document.' : 'Threat analysis is running.'}
          </p>
        )}

        {/* Pipeline config */}
        <details className={`${setupStyles.configPanel} workbench-panel group`}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold text-[#111111] sm:px-6">
            <span>Advanced configuration</span>
            <span className="text-xs font-normal text-[#666666] group-open:hidden">{providerLabel} · {profileLabel}</span>
            <span className="hidden text-xs font-normal text-[#666666] group-open:inline">Hide settings</span>
          </summary>
          <div className="border-t border-[#e4e4e2] px-5 py-5 sm:px-6">
            <ModelSelector value={config} onChange={setConfig} ollamaModels={health?.ollamaModels} />

          <div className="border-t border-slate-100 mt-4 pt-4 grid grid-cols-2 gap-4">
            <div>
              <div className="mb-1.5 flex items-center gap-1">
                <label htmlFor="analyst-mode" className="text-xs font-medium text-slate-600">Analyst mode</label>
                <AnalystModeHelp mode={selectedAnalystMode} />
              </div>
              <select
                id="analyst-mode"
                className="w-full px-3 py-2 rounded-sm border border-slate-300 text-sm text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
                value={config.executionMode ?? 'hybrid'}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    executionMode: e.target.value as AnalysisConfig['executionMode'],
                  })
                }
                aria-label="Analyst execution mode"
              >
                {ANALYST_MODES.map((mode) => (
                  <option key={mode.id} value={mode.id}>{mode.option}</option>
                ))}
              </select>
              <p className="mt-2 text-[11px] leading-5 text-[#666666]">{selectedAnalystMode.description}</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">Debate Rounds</label>
              <select
                className="w-full px-3 py-2 rounded-sm border border-slate-300 text-sm text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
                value={config.maxDebateRounds ?? 2}
                onChange={(e) => setConfig({ ...config, maxDebateRounds: parseInt(e.target.value) })}
              >
                <option value={1}>1: one turn per team</option>
                <option value={2}>2: two turns per team (default)</option>
                <option value={3}>3: three turns per team</option>
                <option value={4}>4: four turns per team</option>
              </select>
              <p className="mt-2 text-[11px] leading-5 text-[#666666]">Every round is Red then Blue. Both teams complete the selected number of turns before consensus or adjudication.</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">Target Threats</label>
              <select
                className="w-full px-3 py-2 rounded-sm border border-slate-300 text-sm text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
                value={config.targetThreats ?? 15}
                onChange={(e) => setConfig({ ...config, targetThreats: parseInt(e.target.value) })}
              >
                <option value={8}>8 — Minimal</option>
                <option value={12}>12</option>
                <option value={15}>15 — Default</option>
                <option value={20}>20 — Thorough</option>
              </select>
            </div>
          </div>
          </div>
        </details>

        <details className={`${setupStyles.configPanel} workbench-panel`}><summary className="cursor-pointer px-5 py-4 text-sm font-semibold">Knowledge retrieval · {config.useRag === false ? 'off' : health?.rag?.usable ? 'available' : 'check readiness'}</summary><RagRunSettings
          enabled={config.useRag !== false}
          health={health}
          onChange={(useRag) => setConfig((current) => ({ ...current, useRag }))}
        /></details>

        <section className={setupStyles.preflight} aria-labelledby="preflight-title">
          <p className="text-[10px] font-bold uppercase tracking-[.14em]">Before you start / 02</p>
          <h2 id="preflight-title" className="workbench-heading mt-1 text-lg">Review the run setup.</h2>
          <dl className="mt-3 grid gap-x-5 gap-y-2 text-xs sm:grid-cols-2">
            <div><dt className="font-semibold">Project</dt><dd>{activeProject?.name ?? 'Select a project'}</dd></div>
            <div><dt className="font-semibold">Inputs</dt><dd>{isImportingRun ? 'Loading previous run…' : input.trim() ? `${formatInteger(input.length)} description characters` : 'No description'} · {uploadedInputs.length} documents{uploadedInputs.length ? ` (${formatInteger(uploadedInputs.reduce((sum, item) => sum + item.extractedLength, 0))} extracted characters)` : ''}</dd></div>
            <div><dt className="font-semibold">Provider and execution</dt><dd>{providerLabel} · {profileLabel} · {selectedAnalystMode.label}</dd></div>
            <div><dt className="font-semibold">Knowledge retrieval</dt><dd>{config.useRag === false ? 'Off: architecture only' : health?.rag?.usable ? 'On: usable now' : 'On: readiness needs attention'}</dd></div>
            <div><dt className="font-semibold">Methods</dt><dd>{(config.enabledAnalysts ?? []).join(', ') || 'None selected'} · {config.maxDebateRounds ?? 2} debate rounds</dd></div>
            <div><dt className="font-semibold">Same-system review memory</dt><dd>{!systemId ? 'New system: no prior decisions' : reviewMemoryCount === null ? 'Checking eligible history…' : reviewMemoryCount === undefined ? 'History unavailable; scan can still start' : reviewMemoryCount === 0 ? 'No fully reviewed prior run' : `${reviewMemoryCount} prior decisions available as context only`}</dd></div>
          </dl>
          <p className="mt-3 text-xs">Prior decisions never set an automatic verdict. Confirm unknowns and control operation during human review. <a href="/docs#review-memory" className="underline">How review memory works</a></p>
        </section>

        {/* Error */}
        {error && (
          <div role="alert" aria-live="polite" className="flex items-start gap-3 px-4 py-3 rounded-sm bg-red-50 border border-red-200 text-sm text-red-700">
            <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            {error}
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={isRunning || runState === 'uploading' || workspaceBlocked || isImportingRun || !draftReady}
          aria-busy={isRunning || runState === 'uploading'}
          className="philo-primary-action flex min-h-11 w-full items-center justify-center gap-2 py-3 text-sm"
        >
          {(runState === 'uploading' || runState === 'running') && (
            <span className="loading loading-spinner loading-sm" />
          )}
          {runState === 'idle' && workspaceBlocked && (workspaceReady === null ? 'Loading project workspace…' : 'Select or create a project to continue')}
          {runState === 'idle' && !workspaceBlocked && (isImportingRun || !draftReady ? 'Loading previous run inputs…' : 'Start Threat Analysis')}
          {runState === 'uploading' && 'Uploading file…'}
          {runState === 'running'   && 'Pipeline running…'}
          {runState === 'done'      && 'Opening live analysis…'}
          {runState === 'error'     && 'Retry Analysis'}
        </button>
      </form>
    </div>
  )
}
