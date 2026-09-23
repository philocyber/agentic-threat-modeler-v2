'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import mermaid from 'mermaid'
import {
  ArrowsPointingInIcon,
  ArrowsPointingOutIcon,
  MinusIcon,
  PlusIcon,
} from '@heroicons/react/24/outline'
import { sanitizeSvg } from '@/lib/security/sanitize-svg'
import styles from './mermaid-diagram.module.css'
import {
  TransformWrapper,
  TransformComponent,
  type ReactZoomPanPinchContentRef,
} from 'react-zoom-pan-pinch'

type MermaidDiagramProps = {
  chart: string
  className?: string
}

let mermaidInitialized = false
// Mermaid keeps renderer state at module scope and is not safe when React
// mounts multiple diagrams concurrently (especially Strict Mode's effect
// replay). Serialize renders so one diagram cannot remove another's scratch SVG.
let mermaidRenderQueue: Promise<void> = Promise.resolve()

function fitDiagram(ref: ReactZoomPanPinchContentRef, animationMs = 0, scaleBoost = 1) {
  window.requestAnimationFrame(() => {
    const wrapper = ref.instance.wrapperComponent
    const content = ref.instance.contentComponent
    if (!wrapper || !content) return
    const fittedScale = Math.min(
      1,
      (wrapper.clientWidth - 32) / content.offsetWidth,
      (wrapper.clientHeight - 32) / content.offsetHeight,
    )
    const scale = Math.max(0.05, Math.min(1, fittedScale * scaleBoost))
    const x = (wrapper.clientWidth - content.offsetWidth * scale) / 2
    const y = (wrapper.clientHeight - content.offsetHeight * scale) / 2
    ref.setTransform(x, y, scale, animationMs)
  })
}

export function MermaidDiagram({ chart, className = '' }: MermaidDiagramProps) {
  const reactId = useId()
  const diagramRef = useRef<HTMLDivElement>(null)
  const fullscreenRef = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    if (!isFullscreen) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    fullscreenRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsFullscreen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [isFullscreen])

  useEffect(() => {
    let cancelled = false
    const id = `mermaid${reactId.replace(/[^a-zA-Z0-9]/g, '')}`

    async function renderDiagram() {
      try {
        if (cancelled) return

        if (!mermaidInitialized) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          htmlLabels: false,
          theme: 'base',
          themeVariables: {
            primaryColor: '#f5f5f3',
            primaryTextColor: '#111111',
            primaryBorderColor: '#666666',
            lineColor: '#666666',
            secondaryColor: '#cacac7',
            tertiaryColor: '#218848',
            background: '#ffffff',
            mainBkg: '#f5f5f3',
            clusterBkg: '#fcfcfb',
            clusterBorder: '#cacac7',
            clusterTextColor: '#666666',
            edgeLabelBackground: '#fcfcfb',
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
            fontSize: '14px',
          },
          flowchart: {
            curve: 'stepAfter',
            nodeSpacing: 54,
            rankSpacing: 78,
            padding: 16,
            useMaxWidth: false,
          },
        })
          mermaidInitialized = true
        }

        document.getElementById(id)?.remove()
        await mermaid.parse(chart)
        const rendered = await mermaid.render(id, chart)
        if (!cancelled) {
          setSvg(sanitizeSvg(rendered.svg))
          setError('')
        }
      } catch (renderError) {
        document.getElementById(id)?.remove()
        if (!cancelled) {
          console.error('Architecture diagram render failed', renderError)
          setSvg('')
          setError('The diagram could not be rendered from the available architecture data.')
        }
      }
    }

    mermaidRenderQueue = mermaidRenderQueue.then(renderDiagram, renderDiagram)
    return () => {
      cancelled = true
      document.getElementById(id)?.remove()
    }
  }, [chart, reactId])

  useEffect(() => {
    if (!svg || !diagramRef.current) return

    // Mermaid's native-SVG labels keep the graph safe and printable. Add the
    // ThreatCanvas-style semantic emphasis after sanitization: findings are
    // signal red, controls earth green, while component names stay charcoal.
    diagramRef.current.querySelectorAll<SVGTSpanElement>('g.node text > tspan.row').forEach((row) => {
      const label = row.textContent?.trim() ?? ''
      if (label === 'T' || label.startsWith('T ')) {
        row.style.setProperty('fill', '#DD2B37', 'important')
        row.style.setProperty('font-weight', '700')
      } else if (label === 'C' || label.startsWith('C ')) {
        row.style.setProperty('fill', '#218848', 'important')
        row.style.setProperty('font-weight', '700')
      }
    })
  }, [svg])

  if (error) {
    return (
      <div className={`border border-amber-300 bg-amber-50 px-5 py-4 text-sm text-amber-950 ${className}`}>
        <p className="font-semibold">Diagram unavailable</p>
        <p className="mt-1 text-amber-800">{error} The structured component and data-flow tables remain available below.</p>
      </div>
    )
  }

  // Mount the transform canvas only after Mermaid has produced the SVG. That
  // makes the initial fit measure the real diagram instead of an empty shell.
  if (!svg) {
    return (
      <div className={`${styles.frame} grid place-items-center bg-[#fcfcfb] text-sm text-[#666666] ${className}`}>
        Rendering architecture…
      </div>
    )
  }

  const diagramContent = (
    <TransformWrapper
      initialScale={1}
      minScale={0.05}
      maxScale={3}
      smooth={false}
      // Start with the whole topology visible. Users can zoom into labels, but
      // an initially cropped canvas looked indistinguishable from a bad render.
      onInit={(ref) => {
        fitDiagram(ref)
        // Tab layout can settle after the zoom wrapper initializes.
        window.setTimeout(() => fitDiagram(ref), 120)
      }}
      limitToBounds={false}
      wheel={{ step: 0.035 }}
      doubleClick={{ mode: 'zoomIn', step: 0.2 }}
    >
      {(controls) => (
        <>
          <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-sm border border-[#cacac7] bg-white p-1 shadow-[0_4px_14px_rgba(44,40,43,0.08)] sm:right-4 sm:top-4">
            {([
              { label: 'Zoom in', action: () => controls.zoomIn(0.15), content: <PlusIcon className="h-4 w-4" /> },
              { label: 'Zoom out', action: () => controls.zoomOut(0.15), content: <MinusIcon className="h-4 w-4" /> },
              { label: 'Fit diagram', action: () => fitDiagram(controls, 180), content: <><ArrowsPointingInIcon className="h-4 w-4" /><span className="hidden sm:inline">Fit</span></> },
              {
                label: isFullscreen ? 'Exit fullscreen' : 'Fullscreen',
                action: () => {
                  setIsFullscreen((value) => !value)
                  window.setTimeout(() => fitDiagram(controls, 180), 0)
                },
                content: isFullscreen
                  ? <><ArrowsPointingInIcon className="h-4 w-4" /><span className="hidden sm:inline">Close</span></>
                  : <><ArrowsPointingOutIcon className="h-4 w-4" /><span className="hidden sm:inline">Full screen</span></>,
              },
            ] satisfies Array<{ label: string; action: () => void; content: ReactNode }>).map((control) => (
              <button
                key={control.label}
                type="button"
                onClick={control.action}
                title={control.label}
                aria-label={control.label}
                className="inline-flex min-h-9 min-w-9 items-center justify-center gap-1.5 rounded-sm px-2.5 text-xs font-semibold text-[#444444] transition-colors hover:bg-[#f1f1f0]"
              >
                {control.content}
              </button>
            ))}
          </div>
          <div className="absolute bottom-3 left-3 z-10 hidden rounded-sm border border-[#cacac7] bg-white px-2.5 py-1.5 text-xs text-[#666666] shadow-sm sm:block">
            Drag to pan · Scroll to zoom
          </div>
          <TransformComponent
            wrapperStyle={{ width: '100%', height: '100%' }}
            contentStyle={{ width: 'max-content', height: 'max-content', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px' }}
          >
            <div
              ref={diagramRef}
              className="[&_.cluster-label]:overflow-visible [&_.cluster-label_text]:font-bold [&_.cluster-label_text]:tracking-[0.08em] [&_.cluster-label_text]:fill-[#666666] [&_.edgeLabel]:overflow-visible [&_.edgeLabel]:bg-[#fcfcfb] [&_.edgeLabel_text]:fill-[#666666] [&_.flowchart-link]:stroke-[#666666] [&_.node_text]:font-semibold [&_.node_text]:fill-[#111111] [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-none [&_svg]:overflow-visible"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </TransformComponent>
        </>
      )}
    </TransformWrapper>
  )

  if (isFullscreen) {
    return <div ref={fullscreenRef} role="dialog" aria-modal="true" aria-label="Architecture diagram fullscreen view" tabIndex={-1} className="fixed inset-0 z-[100] bg-[#fcfcfb] bg-[radial-gradient(#cacac7_0.8px,transparent_0.8px)] [background-size:28px_28px]">{diagramContent}</div>
  }

  return (
    <div className={`${styles.frame} relative overflow-hidden bg-[#fcfcfb] bg-[radial-gradient(#cacac7_0.8px,transparent_0.8px)] [background-size:28px_28px] ${className}`}>
      {diagramContent}
    </div>
  )
}
