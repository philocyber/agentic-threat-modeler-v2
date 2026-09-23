import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '../../..')
const SOURCE_ROOTS = ['app', 'components']
const BLOCK_ELEMENTS = new Set([
  'article', 'aside', 'div', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'main', 'nav', 'ol', 'p', 'section', 'table', 'ul',
])

function listTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return listTsxFiles(target)
    return entry.isFile() && entry.name.endsWith('.tsx') ? [target] : []
  })
}

function sourceFile(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

function hasUseClient(source: ts.SourceFile): boolean {
  return source.statements.some((statement) =>
    ts.isExpressionStatement(statement)
    && ts.isStringLiteral(statement.expression)
    && statement.expression.text === 'use client',
  )
}

function textOf(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source)
}

function findBrowserStateInitializers(source: ts.SourceFile): string[] {
  const findings: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useState' && node.arguments[0]) {
      const initializer = textOf(node.arguments[0], source)
      if (/\b(window|document|localStorage|sessionStorage|navigator)\b/.test(initializer)) {
        findings.push(`${path.relative(ROOT, source.fileName)}:${source.getLineAndCharacterOfPosition(node.pos).line + 1} initializes state from a browser API`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

function findUnstableJsx(source: ts.SourceFile): string[] {
  const findings: string[] = []
  const inspectExpression = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return
    const expression = textOf(node, source)
    const unstable = ts.isNewExpression(node) && expression.startsWith('new Date(')
      || ts.isCallExpression(node) && /(?:Date\.now|Math\.random|crypto\.randomUUID|\.toLocale(?:String|DateString|TimeString))\s*\(/.test(expression)
    if (unstable) {
      findings.push(`${path.relative(ROOT, source.fileName)}:${source.getLineAndCharacterOfPosition(node.pos).line + 1} renders a time, random, or locale-dependent value`)
      return
    }
    ts.forEachChild(node, inspectExpression)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isJsxExpression(node) && node.expression) inspectExpression(node.expression)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

function jsxTagName(node: ts.JsxTagNameExpression): string {
  return node.getText()
}

function findInvalidParagraphChildren(source: ts.SourceFile): string[] {
  const findings: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && jsxTagName(node.openingElement.tagName) === 'p') {
      for (const child of node.children) {
        if (ts.isJsxElement(child) && BLOCK_ELEMENTS.has(jsxTagName(child.openingElement.tagName))) {
          findings.push(`${path.relative(ROOT, source.fileName)}:${source.getLineAndCharacterOfPosition(child.pos).line + 1} nests a block element inside <p>`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

describe('hydration safety audit', () => {
  const files = SOURCE_ROOTS.flatMap((directory) => listTsxFiles(path.join(ROOT, directory)))
  const sources = files.map(sourceFile)

  it('keeps browser-only values out of client state initializers', () => {
    const findings = sources.filter(hasUseClient).flatMap(findBrowserStateInitializers)
    expect(findings, findings.join('\n')).toEqual([])
  })

  it('keeps nondeterministic values out of client-rendered JSX', () => {
    const findings = sources.filter(hasUseClient).flatMap(findUnstableJsx)
    expect(findings, findings.join('\n')).toEqual([])
  })

  it('avoids paragraph structures that the browser repairs before hydration', () => {
    const findings = sources.flatMap(findInvalidParagraphChildren)
    expect(findings, findings.join('\n')).toEqual([])
  })

  it('keeps the navigation list server-owned and does not suppress root warnings', () => {
    const nav = readFileSync(path.join(ROOT, 'components/nav-bar.tsx'), 'utf8')
    const layout = readFileSync(path.join(ROOT, 'app/layout.tsx'), 'utf8')
    expect(nav).not.toContain("'use client'")
    expect(nav).toContain('NavigationLink')
    expect(layout).not.toContain('suppressHydrationWarning')
  })
})
