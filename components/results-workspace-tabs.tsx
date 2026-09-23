'use client'

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowsRightLeftIcon,
  ChatBubbleLeftRightIcon,
  ClipboardDocumentCheckIcon,
  DocumentTextIcon,
  ListBulletIcon,
} from '@heroicons/react/24/outline'
import styles from './results-workspace-tabs.module.css'

export type ResultWorkspaceTabId = 'findings' | 'architecture' | 'debate' | 'report' | 'run'

export type ResultWorkspaceTab = {
  id: ResultWorkspaceTabId
  label: string
  badge?: string | number
  content: ReactNode
}

const ICONS: Record<ResultWorkspaceTabId, typeof ListBulletIcon> = {
  findings: ListBulletIcon,
  architecture: ArrowsRightLeftIcon,
  debate: ChatBubbleLeftRightIcon,
  report: DocumentTextIcon,
  run: ClipboardDocumentCheckIcon,
}

export function ResultsWorkspaceTabs({ tabs }: { tabs: ResultWorkspaceTab[] }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const requestedSection = searchParams.get('section')
  const activeId = tabs.some(tab => tab.id === requestedSection) ? requestedSection as ResultWorkspaceTabId : tabs[0]?.id ?? 'findings'
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0]

  useEffect(() => {
    const active = tabRefs.current.find((tab) => tab?.getAttribute('aria-selected') === 'true')
    const strip = active?.parentElement?.parentElement
    if (active && strip) strip.scrollTo({ left: active.offsetLeft - (strip.clientWidth - active.clientWidth) / 2, behavior: 'auto' })
  }, [activeId])

  function selectTab(id: ResultWorkspaceTabId) {
    const url = new URL(window.location.href)
    if (id === 'findings') url.searchParams.delete('section')
    else url.searchParams.set('section', id)
    router.replace(`${url.pathname}${url.search}`, { scroll: false })
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = tabs.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const next = tabs[nextIndex]
    if (!next) return
    selectTab(next.id)
    tabRefs.current[nextIndex]?.focus()
  }

  if (!activeTab) return null

  return (
    <section aria-label="Analysis workspace">
      <div className={`${styles.shell} results-tabs z-30 overflow-x-auto`}>
        <div className={styles.list} role="tablist" aria-label="Analysis sections">
          {tabs.map((tab, index) => {
            const active = tab.id === activeTab.id
            const Icon = ICONS[tab.id]
            return (
              <button
                key={tab.id}
                ref={(node) => { tabRefs.current[index] = node }}
                id={`result-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`result-panel-${tab.id}`}
                tabIndex={active ? 0 : -1}
                onClick={() => selectTab(tab.id)}
                onKeyDown={(event) => onKeyDown(event, index)}
                className={`${styles.tab} ${active ? styles.active : ''}`}
              >
                <Icon className="size-4" aria-hidden="true" />
                {tab.label}
                {tab.badge !== undefined ? <span className={styles.badge}>{tab.badge}</span> : null}
              </button>
            )
          })}
        </div>
      </div>

      {tabs.map((tab) => <div
        key={tab.id}
        id={`result-panel-${tab.id}`}
        role="tabpanel"
        aria-labelledby={`result-tab-${tab.id}`}
        tabIndex={tab.id === activeTab.id ? 0 : -1}
        hidden={tab.id !== activeTab.id}
        className="mt-4 min-w-0 focus:outline-none"
      >
        {(tab.id === 'findings' || tab.id === activeTab.id) ? tab.content : null}
      </div>)}
    </section>
  )
}
