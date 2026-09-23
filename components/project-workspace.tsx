'use client'

import { FormEvent, useEffect, useState, useSyncExternalStore } from 'react'
import { formatFullDate } from '@/lib/ui/format'

export type ProjectSummary = {
  id: string
  name: string
  path: string
  createdAt: string
}

const ACTIVE_PROJECT_KEY = 'agentic-tm:active-project'
const activeProjectListeners = new Set<() => void>()

function subscribeToActiveProject(callback: () => void): () => void {
  activeProjectListeners.add(callback)
  window.addEventListener('storage', callback)
  return () => {
    activeProjectListeners.delete(callback)
    window.removeEventListener('storage', callback)
  }
}

function readActiveProject(): string | null {
  return window.localStorage.getItem(ACTIVE_PROJECT_KEY)
}

function readActiveProjectOnServer(): null {
  return null
}

type ProjectWorkspaceProps = {
  onActiveProjectChange?: (project: ProjectSummary | null, requiresProject: boolean) => void
}

export function ProjectWorkspace({ onActiveProjectChange }: ProjectWorkspaceProps = {}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const activeProjectId = useSyncExternalStore(
    subscribeToActiveProject,
    readActiveProject,
    readActiveProjectOnServer,
  )
  const [projectName, setProjectName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function loadProjects(): Promise<void> {
      try {
        const [projectsResponse, activeResponse] = await Promise.all([
          fetch('/api/v1/projects', { cache: 'no-store' }),
          fetch('/api/v1/projects/active', { cache: 'no-store' }),
        ])
        if (!projectsResponse.ok || !activeResponse.ok) throw new Error('Could not load local projects')
        const payload = (await projectsResponse.json()) as { data: ProjectSummary[] }
        const activePayload = (await activeResponse.json()) as {
          data: ProjectSummary | null
          requiresProject: boolean
        }
        setProjects(payload.data)
        if (activePayload.data) {
          window.localStorage.setItem(ACTIVE_PROJECT_KEY, activePayload.data.id)
        } else {
          window.localStorage.removeItem(ACTIVE_PROJECT_KEY)
        }
        activeProjectListeners.forEach((listener) => listener())
        onActiveProjectChange?.(activePayload.data, activePayload.requiresProject)
      } catch {
        setError('Could not load local projects. Try refreshing this page.')
      }
    }

    void loadProjects()
  }, [onActiveProjectChange])

  async function selectProject(projectId: string): Promise<void> {
    const response = await fetch('/api/v1/projects/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    })
    const body = await response.json().catch(() => ({})) as { data?: ProjectSummary; error?: string }
    if (!response.ok || !body.data) {
      setError(body.error ?? 'Could not select the project. Refresh the project list and try again.')
      return
    }
    window.localStorage.setItem(ACTIVE_PROJECT_KEY, projectId)
    activeProjectListeners.forEach((listener) => listener())
    window.dispatchEvent(new Event('agentictm:project-changed'))
    onActiveProjectChange?.(body.data, false)
    setError(null)
  }

  async function createProject(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!projectName.trim()) return

    setIsCreating(true)
    setError(null)
    try {
      const response = await fetch('/api/v1/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: projectName }),
      })
      const payload = (await response.json().catch(() => ({}))) as { data?: ProjectSummary; error?: string }
      if (!response.ok || !payload.data) throw new Error(payload.error ?? 'Could not create project')
      const createdProject = payload.data
      setProjects((current) => [createdProject, ...current])
      setProjectName('')
      window.localStorage.setItem(ACTIVE_PROJECT_KEY, createdProject.id)
      activeProjectListeners.forEach((listener) => listener())
      window.dispatchEvent(new Event('agentictm:project-changed'))
      onActiveProjectChange?.(createdProject, false)
    } catch (createError) {
      setError(createError instanceof Error
        ? createError.message
        : 'Could not create the project. Check the local workspace permissions and try again.')
    } finally {
      setIsCreating(false)
    }
  }

  const activeProject = projects.find((project) => project.id === activeProjectId)

  return (
    <section className="ledger-panel overflow-hidden" aria-labelledby="project-workspace-title">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b ledger-rule px-5 py-4 sm:px-6">
        <div>
          <h2 id="project-workspace-title" className="text-lg font-semibold text-[#111111]">
            Work from a project folder you control
          </h2>
        </div>
        {activeProject && (
          <span className="border border-[#e4e4e2] bg-[#f1f1f0] px-2 py-1 font-mono text-[11px] text-[#666666]">
            {activeProject.name}
          </span>
        )}
      </div>
      <div className="grid gap-6 px-5 py-5 lg:grid-cols-[1fr_1.2fr] sm:px-6">
        <form className="space-y-3" onSubmit={createProject}>
          <label htmlFor="project-name" className="block text-sm font-semibold text-[#111111]">
            Create a project
          </label>
          <p className="text-xs leading-5 text-[#666666]">
            Each project creates a local folder with its SQLite database, inputs, runs, prompts, and exports.
          </p>
          <input
            id="project-name"
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            maxLength={120}
            required
            placeholder="e.g. Payments API"
            className="min-h-11 w-full border border-[#cacac7] bg-white px-3 text-sm text-[#111111] outline-none focus:border-[#111111] focus:ring-2 focus:ring-[#e4e4e2]"
          />
          <button
            type="submit"
            disabled={isCreating}
            className="inline-flex min-h-11 items-center bg-[#111111] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#333333] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isCreating ? 'Creating project…' : 'Create local project'}
          </button>
        </form>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#111111]">Open a local project</p>
          <p className="mt-1 text-xs leading-5 text-[#666666]">
            Select a project to make it the active workspace for upcoming scans.
          </p>
          <div className="mt-3 max-h-40 divide-y divide-[#e9e3e5] overflow-y-auto border-y border-[#e9e3e5]">
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                aria-pressed={project.id === activeProjectId}
                onClick={() => void selectProject(project.id)}
                className={`flex min-h-12 w-full items-center justify-between gap-3 px-2 text-left text-sm transition-colors ${
                  project.id === activeProjectId
                    ? 'bg-[#f1f1f0] text-[#111111]'
                    : 'text-[#666666] hover:bg-[#f1f1f0]'
                }`}
              >
                <span className="min-w-0 truncate font-medium">{project.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-[#716f68]">
                  {formatFullDate(project.createdAt)}
                </span>
              </button>
            ))}
            {projects.length === 0 && (
              <p className="px-2 py-4 text-xs text-[#666666]">No local projects yet.</p>
            )}
          </div>
        </div>
      </div>
      {error && (
        <p role="alert" className="border-t border-red-200 bg-red-50 px-5 py-3 text-xs text-red-800 sm:px-6">
          {error}
        </p>
      )}
    </section>
  )
}
