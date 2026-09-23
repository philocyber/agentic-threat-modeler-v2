'use client'
import { useState } from 'react'
import { MarkdownViewer } from './markdown-viewer'

export function InputViewer({ input }: { input: string }) {
  const [viewMode, setViewMode] = useState<'markdown' | 'text'>('markdown')

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">Original Input</h3>
        <div className="join">
          <button
            className={`join-item btn btn-xs ${viewMode === 'markdown' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setViewMode('markdown')}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
            Markdown
          </button>
          <button
            className={`join-item btn btn-xs ${viewMode === 'text' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setViewMode('text')}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Text
          </button>
        </div>
      </div>
      
      {viewMode === 'markdown' ? (
        <MarkdownViewer content={input} />
      ) : (
        <pre className="bg-slate-50 text-slate-800 p-4 rounded-sm overflow-x-auto text-sm leading-relaxed whitespace-pre-wrap border border-slate-200">
          {input}
        </pre>
      )}
    </div>
  )
}
