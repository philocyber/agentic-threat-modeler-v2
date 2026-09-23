'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  ArrowRightIcon,
  ArrowPathIcon,
  CircleStackIcon,
  CloudArrowUpIcon,
  DocumentTextIcon,
  MagnifyingGlassIcon,
  ShieldCheckIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { formatDateTime } from '@/lib/ui/format'
// Type-only import: erased at build time, so the server module never reaches the client bundle.
import type { KnowledgeDomain } from '@/lib/rag/knowledge-files'
import { useServiceHealth } from '@/components/service-health'
import styles from './knowledge.module.css'

type KnowledgeDestination = {
  id: string
  domain: KnowledgeDomain
  label: string
  description: string
  relativeDirectory: string
  allowedExtensions: string[]
}
type KnowledgeFile = {
  path: string
  domain: KnowledgeDomain
  size: number
  modifiedAt: string
  extension: string
  retrievalStatus?: 'eligible' | 'skipped'
  retrievalNote?: string
}
type IndexJob = {
  id: string | null
  status: 'idle' | 'running' | 'succeeded' | 'failed'
  startedAt: string | null
  completedAt: string | null
  logs: string[]
  error: string | null
}
type IndexReadiness = import('@/lib/rag/index-state').RAGIndexReadiness

const EMPTY_JOB: IndexJob = { id: null, status: 'idle', startedAt: null, completedAt: null, logs: [], error: null }
const EMPTY_INDEX: IndexReadiness = { indexedAt: null, needsReindex: false, reason: 'no-source-files', sourceCount: 0 }

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function IndexStatus({ job }: { job: IndexJob }) {
  return <span className={styles.jobBadge} data-state={job.status}>{job.status}</span>
}

export default function KnowledgePage() {
  const health = useServiceHealth()
  const inputRef = useRef<HTMLInputElement>(null)
  const [isLoadingKnowledge, setIsLoadingKnowledge] = useState(true)
  const [knowledgeError, setKnowledgeError] = useState('')
  const [indexError, setIndexError] = useState('')
  const [isLoadingIndex, setIsLoadingIndex] = useState(true)
  const [hasKnowledge, setHasKnowledge] = useState(false)
  const [hasIndex, setHasIndex] = useState(false)
  const [files, setFiles] = useState<KnowledgeFile[]>([])
  const [destinations, setDestinations] = useState<KnowledgeDestination[]>([])
  const [domain, setDomain] = useState<KnowledgeDomain>('technical')
  const [destinationId, setDestinationId] = useState('technical-general')
  const [queuedFiles, setQueuedFiles] = useState<File[]>([])
  const [replaceExisting, setReplaceExisting] = useState(false)
  const [search, setSearch] = useState('')
  const [showAllFiles, setShowAllFiles] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [job, setJob] = useState<IndexJob>(EMPTY_JOB)
  const [indexReadiness, setIndexReadiness] = useState<IndexReadiness>(EMPTY_INDEX)

  const refreshKnowledge = useCallback(async (): Promise<void> => {
    setIsLoadingKnowledge(true)
    setIsLoadingIndex(true)
    setKnowledgeError('')
    setIndexError('')
    // Publish each result independently: index availability must not hide files.
    await Promise.allSettled([
      (async () => {
        try {
          const response = await fetch('/api/v1/knowledge', { cache: 'no-store', signal: AbortSignal.timeout(30_000) })
          if (!response.ok) throw new Error(`Document inventory could not be loaded (HTTP ${response.status}).`)
          const knowledge = await response.json() as { files: KnowledgeFile[]; destinations: KnowledgeDestination[] }
          setFiles(knowledge.files)
          setDestinations(knowledge.destinations)
          setHasKnowledge(true)
        } catch (loadError) {
          setKnowledgeError(loadError instanceof Error ? loadError.message : 'Document inventory could not be loaded.')
        } finally {
          setIsLoadingKnowledge(false)
        }
      })(),
      (async () => {
        try {
          const response = await fetch('/api/v1/index', { cache: 'no-store', signal: AbortSignal.timeout(30_000) })
          if (!response.ok) throw new Error(`Index status could not be loaded (HTTP ${response.status}).`)
          const index = await response.json() as { index: IndexReadiness; job: IndexJob }
          setJob(index.job)
          setIndexReadiness(index.index)
          setHasIndex(true)
        } catch (loadError) {
          setIndexError(loadError instanceof Error ? loadError.message : 'Index status could not be loaded.')
        } finally {
          setIsLoadingIndex(false)
        }
      })(),
    ])
  }, [])

  /* eslint-disable react-hooks/set-state-in-effect -- client-side status bootstrap;
     subsequent updates come from the upload and index event handlers. */
  useEffect(() => {
    void refreshKnowledge().catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : 'Knowledge status could not be loaded')
    })
  }, [refreshKnowledge])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (job.status !== 'running') return
    const timer = window.setInterval(() => {
      void fetch('/api/v1/index', { cache: 'no-store' })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error('Index status is unavailable')))
        .then((body: { index: IndexReadiness; job: IndexJob }) => {
          setJob(body.job)
          setIndexReadiness(body.index)
          if (body.job.status === 'succeeded') {
            setMessage('Knowledge index is ready for new analyses.')
          } else if (body.job.status === 'failed') {
            setError(body.job.error ?? 'Knowledge reindex failed')
          }
        })
        .catch((pollError: unknown) => setError(pollError instanceof Error ? pollError.message : 'Index status is unavailable'))
    }, 1500)
    return () => window.clearInterval(timer)
  }, [job.status])

  const domainDestinations = destinations.filter((destination) => destination.domain === domain)
  const destination = destinations.find((item) => item.id === destinationId)
  const domainFiles = files.filter((file) => file.domain === domain)
  const technicalCount = files.filter((file) => file.domain === 'technical').length
  const corporateCount = files.filter((file) => file.domain === 'corporate').length
  const filteredFiles = domainFiles.filter((file) => file.path.toLowerCase().includes(search.trim().toLowerCase()))
  const visibleFiles = showAllFiles || search.trim() ? filteredFiles : filteredFiles.slice(0, 8)

  function selectDomain(nextDomain: KnowledgeDomain): void {
    setDomain(nextDomain)
    const first = destinations.find((item) => item.domain === nextDomain)
    setDestinationId(first?.id ?? `${nextDomain}-general`)
    setQueuedFiles([])
    setSearch('')
    setShowAllFiles(false)
    setMessage('')
    setError('')
  }

  function queueDocuments(nextFiles: File[]): void {
    setMessage('')
    setError('')
    if (!destination) {
      setError('Select a destination before adding documents.')
      return
    }
    const accepted = nextFiles.filter((file) => destination.allowedExtensions.includes(`.${file.name.split('.').pop()?.toLowerCase()}`))
    if (accepted.length !== nextFiles.length) {
      setError(`Some files were skipped. ${destination.label} accepts ${destination.allowedExtensions.join(', ')}.`)
    }
    setQueuedFiles((current) => [...current, ...accepted].slice(0, 20))
  }

  async function uploadDocuments(): Promise<void> {
    if (!destination || queuedFiles.length === 0) return
    setIsUploading(true)
    setMessage('')
    setError('')
    try {
      const formData = new FormData()
      formData.set('domain', domain)
      formData.set('destination', destination.id)
      formData.set('replaceExisting', String(replaceExisting))
      queuedFiles.forEach((file) => formData.append('files', file))
      const response = await fetch('/api/v1/knowledge', { method: 'POST', body: formData })
      const body = await response.json().catch(() => ({})) as { message?: string; error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Knowledge upload failed')
      setQueuedFiles([])
      setMessage(body.message ?? 'Documents added.')
      await refreshKnowledge()
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Knowledge upload failed')
    } finally {
      setIsUploading(false)
    }
  }

  async function startReindex(): Promise<void> {
    setMessage('')
    setError('')
    try {
      const response = await fetch('/api/v1/index', { method: 'POST' })
      const body = await response.json().catch(() => ({})) as { index?: IndexReadiness; job?: IndexJob; error?: string; message?: string }
      if (!response.ok && response.status !== 409) throw new Error(body.error ?? 'Reindex could not be started')
      if (body.job) setJob(body.job)
      if (body.index) setIndexReadiness(body.index)
      setMessage(body.message ?? 'Knowledge reindex started.')
    } catch (indexError) {
      setError(indexError instanceof Error ? indexError.message : 'Reindex could not be started')
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Evidence workspace <span>/ 01</span></p>
          <h1>Knowledge base<span className={styles.period}>.</span></h1>
          <p>Curate the sources your analysts can draw on. Keep the source library, index freshness, and live retrieval status distinct.</p>
          <div className={styles.heroActions}>
            <a href="#source-library" className={styles.heroPrimary}>Explore sources <ArrowRightIcon aria-hidden="true" /></a>
            <Link href="/docs#rag" className={styles.heroLink}>How retrieval works ↗</Link>
          </div>
        </div>
        <div className={styles.heroGraphic} aria-hidden="true">
          <div className={styles.orbitOne} /><div className={styles.orbitTwo} />
          <div className={styles.orbitCore}><CircleStackIcon /></div>
          <span className={styles.orbitLabelOne}>SOURCE</span>
          <span className={styles.orbitLabelTwo}>INDEX</span>
          <span className={styles.orbitLabelThree}>RETRIEVE</span>
        </div>
      </header>

      <section className={styles.readiness} aria-label="Knowledge readiness">
        <div className={styles.readinessItem}><span className={styles.readinessNumber}>01</span><div><p className={styles.readinessLabel}>Source library</p><p className={styles.readinessValue}>{hasKnowledge ? files.length + ' documents' : isLoadingKnowledge ? 'Loading sources' : 'Unavailable'}</p><p className={styles.readinessDetail}>Files present in the local corpus</p></div></div>
        <div className={styles.readinessItem}><span className={styles.readinessNumber}>02</span><div><p className={styles.readinessLabel}>Index freshness</p><p className={styles.readinessValue}>{!hasIndex ? isLoadingIndex ? 'Checking index' : 'Unavailable' : indexReadiness.reason === 'vector-index-unavailable' ? 'Cannot verify' : indexReadiness.needsReindex ? 'Rebuild needed' : indexReadiness.reason === 'up-to-date' ? 'Current' : 'No current index'}</p><p className={styles.readinessDetail}>{indexReadiness.reason === 'vector-index-unavailable' ? 'Check Chroma to confirm index state' : 'Compared with source files'}</p></div></div>
        <div className={styles.readinessItem}><span className={styles.readinessNumber}>03</span><div><p className={styles.readinessLabel}>Retrieval now</p><p className={styles.readinessValue}>{!health ? 'Checking service' : health.rag?.usable ? 'Available' : 'Unavailable'}</p><p className={styles.readinessDetail}>{health?.rag && !health.rag.usable ? health.rag.reason : 'Live service availability'}</p></div></div>
      </section>

      {(knowledgeError || indexError) && <div role="alert" className={styles.alert}>
        {knowledgeError && <p>{knowledgeError} {hasKnowledge ? 'Showing the last loaded inventory.' : 'The inventory is unavailable; this does not mean your documents are missing.'}</p>}
        {indexError && <p>{indexError}</p>}
        <button type="button" disabled={isLoadingKnowledge || isLoadingIndex} onClick={() => void refreshKnowledge()}>Retry loading</button>
      </div>}
      {message && <div role="status" className={styles.notice}>{message}</div>}
      {error && <div role="alert" className={styles.alert}>{error}</div>}

      <div className={styles.workspace}>
        <section id="source-library" className={styles.catalog} aria-labelledby="catalog-title">
          <div className={styles.sectionHeading}>
            <div><p className={styles.kicker}>01 / Sources</p><h2 id="catalog-title">Source library</h2><p>Browse what is stored. An eligible source has not necessarily been indexed or retrieved.</p></div>
            <span className={styles.libraryCount}>{hasKnowledge ? domainFiles.length + ' files' : '—'}</span>
          </div>
          <div className={styles.domainTabs} role="group" aria-label="Knowledge domain">
            {(['technical', 'corporate'] as const).map((item) => (
              <button key={item} type="button" aria-pressed={domain === item} onClick={() => selectDomain(item)} className={[styles.domainButton, domain === item ? styles.activeDomain : ''].join(' ')}>
                <span>{item === 'technical' ? 'Technical intelligence' : 'Corporate context'}</span>
                <strong>{hasKnowledge ? item === 'technical' ? technicalCount : corporateCount : '—'}</strong>
              </button>
            ))}
          </div>
          <div className={styles.catalogToolbar}>
            <label className={styles.searchBox}><MagnifyingGlassIcon aria-hidden="true" /><span className={styles.srOnly}>Search source files</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search documents or folders" /></label>
            <span>{hasKnowledge ? filteredFiles.length + ' in ' + domain : 'Loading inventory'}</span>
          </div>
          {!hasKnowledge ? <div role="status" className={styles.emptyState}>{isLoadingKnowledge ? 'Loading document inventory…' : 'Document inventory could not be loaded. Use Retry loading above.'}</div> : filteredFiles.length ? <>
            <ul className={styles.fileList}>{visibleFiles.map((file, index) => {
              const parts = file.path.split('/')
              const name = parts.pop() ?? file.path
              return <li key={file.path} className={styles.fileRow}>
                <span className={styles.fileNumber}>{String(index + 1).padStart(2, '0')}</span>
                <div className={styles.fileIcon}><DocumentTextIcon aria-hidden="true" /></div>
                <div className={styles.fileIdentity}><p className={styles.fileName}>{name}</p><p className={styles.filePath}>{parts.join(' / ') || domain}</p>{file.retrievalStatus === 'skipped' && <p className={styles.fileWarning}>Skipped: {file.retrievalNote}</p>}</div>
                <div className={styles.fileMeta}><span className={styles.fileExtension}>{file.extension || 'file'}</span><span>{formatBytes(file.size)}</span><time dateTime={file.modifiedAt}>{formatDateTime(file.modifiedAt)}</time></div>
              </li>
            })}</ul>
            {!search.trim() && filteredFiles.length > 8 && <button type="button" className={styles.showMore} onClick={() => setShowAllFiles((current) => !current)}>{showAllFiles ? 'Show fewer documents' : 'Show all ' + filteredFiles.length + ' documents'} <ArrowRightIcon aria-hidden="true" /></button>}
          </> : <div className={styles.emptyState}><ShieldCheckIcon aria-hidden="true" /><p>{search.trim() ? 'No matching documents' : 'No ' + domain + ' documents yet'}</p><span>{search.trim() ? 'Try another file name or folder.' : 'Add reviewed sources in the evidence form.'}</span></div>}
        </section>

        <aside className={styles.rail} aria-label="Knowledge actions">
          <section className={styles.upload} aria-labelledby="upload-title">
            <div className={styles.railHeading}><p className={styles.kicker}>02 / Add sources</p><h2 id="upload-title">Bring in evidence</h2><p>Files stay local. Reindex after upload to make them searchable.</p></div>
            <label htmlFor="knowledge-destination" className={styles.fieldLabel}>Destination</label>
            <select id="knowledge-destination" value={destinationId} onChange={(event) => { setDestinationId(event.target.value); setQueuedFiles([]) }} className={styles.destination}>{domainDestinations.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
            {destination && <p className={styles.destinationHint}>{destination.description}<span>knowledge_base/{destination.relativeDirectory}/</span></p>}
            <div onDragEnter={(event) => { event.preventDefault(); setIsDragging(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false) }} onDrop={(event) => { event.preventDefault(); setIsDragging(false); queueDocuments(Array.from(event.dataTransfer.files)) }} className={[styles.dropZone, isDragging ? styles.dragging : ''].join(' ')}>
              <CloudArrowUpIcon aria-hidden="true" /><p>Drop files here</p><span>Up to 20 files · 25 MB each<br />{destination?.allowedExtensions.join(', ')}</span>
              <button type="button" onClick={() => inputRef.current?.click()}>Choose files</button>
              <input ref={inputRef} type="file" multiple className={styles.hiddenInput} accept={destination?.allowedExtensions.join(',')} onChange={(event) => { queueDocuments(Array.from(event.target.files ?? [])); event.target.value = '' }} />
            </div>
            {queuedFiles.length > 0 && <ul className={styles.uploadQueue}>{queuedFiles.map((file, index) => <li key={file.name + file.size + index}><span>{file.name} <small>{formatBytes(file.size)}</small></span><button type="button" aria-label={'Remove ' + file.name} onClick={() => setQueuedFiles((current) => current.filter((_, queuedIndex) => queuedIndex !== index))}><XMarkIcon aria-hidden="true" /></button></li>)}</ul>}
            <label className={styles.replaceLabel}><input type="checkbox" checked={replaceExisting} onChange={(event) => setReplaceExisting(event.target.checked)} /><span>Replace files with the same name</span></label>
            <button type="button" disabled={!queuedFiles.length || isUploading} onClick={() => void uploadDocuments()} className={styles.primaryButton}>{isUploading ? 'Adding documents…' : 'Add ' + (queuedFiles.length || '') + ' document' + (queuedFiles.length === 1 ? '' : 's')} <ArrowRightIcon aria-hidden="true" /></button>
          </section>
          <section id="index-controls" className={styles.indexPanel} aria-labelledby="index-status-title">
            <div className={styles.railHeading}><p className={styles.kicker}>03 / Make searchable</p><div className={styles.indexTitle}><h2 id="index-status-title">Vector index</h2>{hasIndex && !indexError ? <IndexStatus job={job} /> : <span className={styles.jobBadge}>{isLoadingIndex ? 'Loading' : 'Unavailable'}</span>}</div></div>
            <p className={styles.indexExplanation}>Rebuild the technical catalog and synchronize the corporate Chroma collection. Existing analyses stay as they are.</p>
            {hasIndex && !indexError && job.status !== 'running' && indexReadiness.needsReindex && <p className={styles.indexNote}>{indexReadiness.reason === 'vector-index-empty' ? 'No indexed vectors were found.' : indexReadiness.reason === 'vector-index-unavailable' ? 'The vector index could not be verified. Check Chroma before rebuilding.' : 'Sources have changed since the last index.'}</p>}
            {hasIndex && !indexError && !indexReadiness.needsReindex && indexReadiness.reason === 'up-to-date' && <p className={styles.indexNote}>The index matches the current source library.</p>}
            {indexReadiness.indexedAt && <p className={styles.indexDate}>Last indexed {formatDateTime(indexReadiness.indexedAt)}</p>}
            <button type="button" disabled={!hasIndex || isLoadingIndex || !!indexError || job.status === 'running' || !indexReadiness.needsReindex} onClick={() => void startReindex()} className={styles.indexButton}><ArrowPathIcon className={job.status === 'running' ? styles.spinning : ''} aria-hidden="true" />{isLoadingIndex ? 'Loading index status…' : indexError || !hasIndex ? 'Index status unavailable' : job.status === 'running' ? 'Indexing knowledge…' : indexReadiness.needsReindex ? 'Reindex now' : indexReadiness.reason === 'no-source-files' ? 'No source files to index' : 'Index is up to date'}</button>
            {job.logs.length > 0 && <details className={styles.indexLogs}><summary>Index activity log</summary><pre>{job.logs.slice(-18).join('\n')}</pre></details>}
            {job.error && <p className={styles.indexError}>{job.error}</p>}
            {health?.rag && !health.rag.usable && <Link href="/docs#rag" className={styles.helpLink}>Troubleshoot retrieval <ArrowRightIcon aria-hidden="true" /></Link>}
          </section>
        </aside>
      </div>
    </main>
  )
}
