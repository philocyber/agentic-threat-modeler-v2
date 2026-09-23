'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import dynamic from 'next/dynamic'
import { MermaidDiagram } from './mermaid-diagram'
import type { ReactNode } from 'react'
import { rehypeSafeMarkdown } from '@/lib/security/sanitize-markdown'

const CodeBlock = dynamic(() => import('./code-block').then((module) => module.CodeBlock), {
  ssr: false,
  loading: () => <pre className="overflow-x-auto bg-[#1f2937] p-4 text-xs text-[#e5e7eb]" />,
})

type MarkdownViewerProps = {
  content: string
  className?: string
}

type CodeProps = {
  node?: unknown
  className?: string | undefined
  children?: ReactNode
}

export function MarkdownViewer({ content, className = '' }: MarkdownViewerProps) {
  return (
    <div className={`prose prose-sm max-w-none text-[#111111] ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSafeMarkdown]}
        components={{
          code({ className: cls, children }: CodeProps) {
            const match = /language-(\w+)/.exec(cls ?? '')
            const language = match?.[1]
            const codeContent = String(children).replace(/\n$/, '')

            // Render Mermaid diagrams
            if (language === 'mermaid') {
              return <MermaidDiagram chart={codeContent} />
            }

            if (language === 'text') return <code className={cls}>{children}</code>

            // Render other code blocks with syntax highlighting
            return match ? (
              <CodeBlock language={language}>{codeContent}</CodeBlock>
            ) : (
              <code className={cls}>{children}</code>
            )
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto">
                <table className="table table-sm">{children}</table>
              </div>
            )
          },
          blockquote({ children }) {
            return (
              <blockquote className="my-3 border border-[#cfd5f5] bg-[#f8f9ff] px-4 py-3 text-[#444444] not-italic">
                {children}
              </blockquote>
            )
          },
          h4({ children }) {
            return <h4 className="mt-6 border-b border-[#e4e4e2] pb-2 text-base font-semibold text-[#111111]">{children}</h4>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
