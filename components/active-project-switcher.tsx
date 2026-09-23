'use client'

import { useEffect, useState } from 'react'
import type { ProjectSummary } from '@/components/project-workspace'

export function ActiveProjectSwitcher() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [active, setActive] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      try {
        const [allResponse, activeResponse] = await Promise.all([
          fetch('/api/v1/projects', { cache: 'no-store' }),
          fetch('/api/v1/projects/active', { cache: 'no-store' }),
        ])
        if (!allResponse.ok || !activeResponse.ok) return
        const all = await allResponse.json() as { data?: ProjectSummary[] }
        const selected = await activeResponse.json() as { data?: ProjectSummary | null }
        setProjects(all.data ?? [])
        setActive(selected.data?.id ?? '')
      } catch { /* Navigation remains usable when project discovery is unavailable. */ }
    }
    void load()
    window.addEventListener('agentictm:project-changed', load)
    return () => window.removeEventListener('agentictm:project-changed', load)
  }, [])

  async function switchProject(id: string) {
    if (!id) return
    const previous = active
    setActive(id); setError('')
    try {
      const response = await fetch('/api/v1/projects/active', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: id }),
      })
      if (!response.ok) throw new Error('Could not switch project')
      window.localStorage.setItem('agentic-tm:active-project', id)
      window.dispatchEvent(new Event('agentictm:project-changed'))
      window.location.assign('/')
    } catch {
      setActive(previous)
      setError('Project switch failed')
    }
  }

  return <label className="flex min-w-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[#666666]">
    <span className="sr-only">Active project</span><span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-[#111111]" />
    <select aria-label="Active project" title={error || 'Active project'} value={active} onChange={(event) => void switchProject(event.target.value)} className="max-w-28 min-w-0 border-0 bg-transparent px-1 py-1 text-[11px] font-semibold normal-case tracking-normal text-[#111111] sm:max-w-32">
      <option value="">No project</option>
      {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
    </select>
  </label>
}
