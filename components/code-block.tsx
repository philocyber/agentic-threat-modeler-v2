'use client'

import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { CSSProperties } from 'react'

type CodeBlockProps = {
  language: string | undefined
  children: string
}

/**
 * Split into its own module so react-syntax-highlighter (and its Prism grammars)
 * is fetched only when a report actually contains a fenced code block.
 */
export function CodeBlock({ language, children }: CodeBlockProps) {
  return (
    <SyntaxHighlighter style={oneDark as Record<string, CSSProperties>} language={language} PreTag="div">
      {children}
    </SyntaxHighlighter>
  )
}
