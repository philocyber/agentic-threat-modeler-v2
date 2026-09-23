import { describe, expect, it } from 'vitest'
import { formatAnalysisRequest } from '../format-analysis-request'

describe('formatAnalysisRequest', () => {
  it('renders a plain-text assessment with tabular data and an ASCII diagram', () => {
    const input = [
      'FinanceBot — Threat Model', 'Company: PhiloBank', '',
      '1. Executive Summary', 'Review the architecture.',
      '2. System Architecture', '2.1 Components',
      'ID\tComponent\tTrust Zone', 'C1\tClient\tExternal', 'C2\tGateway\tInternal',
      '2.2 Data Flow', 'text', '+-----------+', '| Client -> |', '+-----------+',
      '2.3 Controls', 'Control operation is unverified.',
    ].join('\n')
    const formatted = formatAnalysisRequest(input)
    expect(formatted).toContain('# FinanceBot — Threat Model')
    expect(formatted).toContain('## 1. Executive Summary')
    expect(formatted).toContain('### 2.1 Components')
    expect(formatted).toContain('| ID | Component | Trust Zone |')
    expect(formatted).toContain('| --- | --- | --- |')
    expect(formatted).toContain('```text\n+-----------+\n| Client -> |\n+-----------+\n```')
    expect(formatted).toContain('### 2.3 Controls')
  })

  it('keeps existing Markdown fences and headings intact', () => {
    const input = '# Request\n\n```text\nA\tB\n1\t2\n```'
    expect(formatAnalysisRequest(input)).toBe(input)
  })

  it('escapes cell pipes so they do not split a table column', () => {
    expect(formatAnalysisRequest('Name\tValue\nMode\tA | B')).toContain('| Mode | A \\| B |')
  })
})
