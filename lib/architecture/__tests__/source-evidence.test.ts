import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HumanMessage } from '@langchain/core/messages'
import type { ArchitectureData, RawThreat } from '@/lib/models/types'
import { verifyArchitectureAnchors, createSourceEvidence, formatSourceSections, packSourceSections, retrieveSourceSections, sourceCharacterBudget, assertExtractionCoverage, assertAnalystCoverage, architectureForFindings } from '../source-evidence'
import { resolveHostedContextCapacity } from '@/lib/llm/context-capacity'
import { analyzeSourcePackets, planSourceAnalysis } from '@/lib/agents/source-analysis'
import { buildArchitectureFactLedger } from '../fact-ledger'
import { fitMessagesToModelContext } from '@/lib/llm/context-guard'

const folder = join(process.cwd(), 'lib/architecture/__tests__/fixtures/six-documents')
const documents = readdirSync(folder).sort().map(file => readFileSync(join(folder, file), 'utf8'))
function architecture(input = documents.join('\n\n')): ArchitectureData {
  const sourceEvidence = createSourceEvidence(input)
  sourceEvidence.extraction.attempted = sourceEvidence.sections.map(s => s.id)
  return { sourceEvidence, systemDescription: 'LedgerBridge exports', components: [{ name: 'LedgerBridge', type: 'service', scope: 'internal' }], dataFlows: [], trustBoundaries: [], dataStores: [], externalEntities: [], apiEndpoints: [], deploymentInfo: '', mermaidDfd: '', techFlags: { hasAI: false, hasAuthSystem: true, hasDatabaseLayer: true, hasExternalIntegrations: false, hasFileStorage: true, hasKubernetes: false, hasMessageQueue: true, hasMicroservices: false } }
}

describe('original source coverage', () => {
  it('retains six documents, headings, late facts and cross-file qualifications exactly', () => {
    const input = documents.join('\n\n')
    const source = createSourceEvidence(input)
    expect(source.sections.map(s => s.text).join('')).toBe(input)
    expect(source.sections).toHaveLength(6)
    expect(source.sections[5]?.text).toContain('cannot read another tenant')
    for (const s of source.sections) expect(input.slice(s.start, s.end)).toBe(s.text)
  })
  it('does not lose whitespace, headings or a long paragraph at boundaries', () => {
    const input = `  # Start\n${'α qualification '.repeat(1800)}\n\n## End\nFinal restriction.  `
    const source = createSourceEvidence(input)
    expect(source.sections.map(s => s.text).join('')).toBe(input)
    expect(packSourceSections(source.sections, 4000).flat().map(s => s.id)).toEqual(source.sections.map(s => s.id))
  })
  it('uses a full packet when capacity allows and fails rather than clipping an oversized section', () => {
    const source = createSourceEvidence(documents.join('\n\n'))
    expect(packSourceSections(source.sections, sourceCharacterBudget({ contextWindow: 131072, outputTokenReserve: 16384 }))).toHaveLength(1)
    expect(() => packSourceSections(source.sections, 50)).toThrow(/coverage blocked/)
    expect(sourceCharacterBudget({ contextWindow: 8192, outputTokenReserve: 8192 })).toBe(0)
  })
  it('retrieves later contradictory context and preserves source text', () => {
    const source = createSourceEvidence(documents.join('\n\n'))
    const passages = retrieveSourceSections(source, 'LedgerBridge')
    expect(formatSourceSections(passages)).toContain('cannot read another tenant')
    expect(formatSourceSections(passages)).toContain('historical description')
    expect(formatSourceSections(passages)).toContain('JWT validation is disabled')
  })
  it('blocks missing/failed extraction and incomplete analyst delivery before debate', () => {
    const arch = architecture()
    expect(() => assertExtractionCoverage(arch)).not.toThrow()
    arch.sourceEvidence!.extraction.failed = ['SRC-0006']
    expect(() => assertExtractionCoverage(arch)).toThrow(/coverage blocked/)
    arch.sourceEvidence!.extraction.failed = []
    expect(() => assertAnalystCoverage(arch, ['stride'])).toThrow(/before debate/)
  })
  it('delivers every section and records success only after every pass finishes', async () => {
    const arch = architecture()
    const seen: string[] = []
    await analyzeSourcePackets(arch, [{ contextWindow: 131072 }], 'stride', async packet => {
      seen.push(...packet.sourceEvidence!.sections.map(s => s.id))
      return []
    })
    expect(seen).toEqual(arch.sourceEvidence!.sections.map(s => s.id))
    expect(() => assertAnalystCoverage(arch, ['stride'])).not.toThrow()
    await expect(analyzeSourcePackets(arch, [{}], 'pasta', async () => { throw new Error('failed extraction of notes') })).rejects.toThrow()
    expect(() => assertAnalystCoverage(arch, ['pasta'])).toThrow()
  })
  it('passes original qualifications to later finding review', () => {
    const arch = architecture()
    const reviewed = architectureForFindings(arch, [{ component: 'LedgerBridge' }], { contextWindow: 131072 })
    expect(formatSourceSections(reviewed.sourceEvidence!.sections)).toContain('cannot read another tenant')
  })
  it('retains all source facts and makes conflicting controls unknown', () => {
    const input = documents.join('\n\n') + '\n' + Array.from({ length: 220 }, (_, i) => `Storage fact ${i} describes a separate archive object.`).join('\n')
    const arch = architecture(input)
    const ledger = buildArchitectureFactLedger(input, arch)
    expect(ledger.sourceFacts.length).toBeGreaterThan(220)
    const jwt = ledger.controls.filter(c => c.name === 'JWT validation')
    expect(jwt.length).toBeGreaterThan(1)
    expect(jwt.every(c => c.status === 'unknown')).toBe(true)
  })
  it('never head/tail compacts original passages on local or hosted models', () => {
    for (const providerName of ['ollama', 'kimi']) {
      expect(() => fitMessagesToModelContext({ providerName, contextWindow: 2048, outputTokenReserve: 1024 }, [new HumanMessage(`[SRC-0001] ${'text'.repeat(3000)}`)])).toThrow(/context is too small/)
    }
  })
  it('uses installed token counts to retain a fitting original bundle in one pass', () => {
    const input = documents.map(doc => doc + `\n${'LedgerBridge operational details. '.repeat(500)}`).join('\n\n')
    const arch = architecture(input)
    const model = { contextWindow: 40960, outputTokenReserve: 8192, countTextTokens: (text: string) => Math.ceil(text.length / 8) }
    const plan = planSourceAnalysis(arch, [model])
    expect(input.length).toBeGreaterThan(sourceCharacterBudget(model))
    expect(plan.packets).toEqual([arch.sourceEvidence!.sections])
    expect(plan.reconciliation).toEqual([])
    expect(architectureForFindings(arch, [{ component: 'LedgerBridge' }], model)).toBe(arch)
  })

  it('handles six substantial files together when configured capacity permits', async () => {
    const input = documents.map((doc, index) => doc + `\n${(`Document ${index + 1} operational detail. `).repeat(700)}`).join('\n\n')
    const arch = architecture(input)
    const seen: string[] = []
    await analyzeSourcePackets(arch, [{ contextWindow: 131072, outputTokenReserve: 16384 }], 'stride', async packet => {
      seen.push(packet.sourceEvidence!.sections.map(s => s.text).join(''))
      return []
    })
    expect(input.length).toBeGreaterThan(120_000)
    expect(seen).toEqual([input])
  })
  it('reconciles shared names across separate packets, without losing any primary section', async () => {
    const input = documents.map((doc, index) => doc + `\n${(`Document ${index + 1} operation. `).repeat(400)}`).join('\n\n')
    const arch = architecture(input)
    const packets: string[] = []
    await analyzeSourcePackets(arch, [{ contextWindow: 24576, outputTokenReserve: 4096 }], 'stride', async packet => {
      packets.push(formatSourceSections(packet.sourceEvidence!.sections))
      return []
    })
    expect(packets.length).toBeGreaterThan(1)
    for (const section of arch.sourceEvidence!.sections) expect(packets.some(p => p.includes(section.text))).toBe(true)
    expect(packets.some(p => p.includes('accepts a tenant export job') && p.includes('cannot read another tenant'))).toBe(true)
    expect(() => assertAnalystCoverage(arch, ['stride'])).not.toThrow()
  })

  it('replaces a reconstructed excerpt with canonical catalog text for a real SRC ID', () => {
    const source = architecture().sourceEvidence!
    const candidate: RawThreat = {
      component: 'LedgerBridge',
      methodology: 'STRIDE',
      description: 'LedgerBridge service identity can read another tenant exports',
      impact: 'Disclosure',
      mitigation: 'Verify permissions',
      confidenceScore: 0.98,
      evidenceSources: [{ sourceType: 'architecture', sourceName: 'SRC-0006', excerpt: 'Every user is a production administrator.' }],
    }
    const checked = verifyArchitectureAnchors(candidate, source)
    expect(checked.evidenceSources[0]).toMatchObject({
      referenceStatus: 'verified',
      passageId: 'SRC-0006',
      supportStatus: 'supports',
    })
    expect(checked.evidenceSources[0]?.excerpt).not.toContain('Every user is a production administrator.')
    expect(checked.evidenceSources[0]?.excerpt).toContain('cannot read another tenant')
    expect(checked.confidenceScore).toBe(0.98)
    const missing = verifyArchitectureAnchors({
      ...candidate,
      evidenceSources: [{ sourceType: 'architecture', sourceName: 'SRC-9999', excerpt: 'Every user is a production administrator.' }],
    }, source)
    expect(missing.confidenceScore).toBe(0.69)
    expect(missing.disposition).toBe('control_verification_needed')
    expect(missing.evidenceSources[0]).toMatchObject({ referenceStatus: 'unverified', supportStatus: 'unlinked' })
  })

  it('does not mark primary coverage complete when a later reconciliation fails', async () => {
    const arch = architecture(documents.map(doc => doc + '\n' + 'LedgerBridge source detail. '.repeat(400)).join('\n\n'))
    const models = [{ contextWindow: 32768, outputTokenReserve: 16384 }]
    const plan = planSourceAnalysis(arch, models)
    expect(plan.reconciliation.length).toBeGreaterThan(0)
    let calls = 0
    await expect(analyzeSourcePackets(arch, models, 'stride', async () => {
      if (++calls > plan.packets.length) throw new Error('reconciliation failed')
      return []
    })).rejects.toThrow('reconciliation failed')
    expect(arch.sourceEvidence!.analystDelivery?.stride).toBeUndefined()
    expect(() => assertAnalystCoverage(arch, ['stride'])).toThrow(/before debate/)
  })

  it('plans a large cross-section case without inference using verified model capacity', () => {
    const input = documents.map(doc => doc + '\n' + 'LedgerBridge source detail. '.repeat(400)).join('\n\n')
    const arch = architecture(input)
    const localPlan = planSourceAnalysis(arch, [{ contextWindow: 32768, outputTokenReserve: 16384 }])
    expect(localPlan.reconciliation.length).toBeGreaterThan(1)
    for (const packet of [...localPlan.packets, ...localPlan.reconciliation]) {
      expect(formatSourceSections(packet).length).toBeLessThanOrEqual(localPlan.budget)
    }
    // Every pair of original sections sharing the component must be jointly
    // available, including early claims and late contradictory qualifications.
    const related = arch.sourceEvidence!.sections.filter(s => s.text.includes('LedgerBridge'))
    for (const left of related) for (const right of related) {
      expect([...localPlan.packets, ...localPlan.reconciliation].some(p => p.includes(left) && p.includes(right))).toBe(true)
    }
    const plan = planSourceAnalysis(arch, [{ ...resolveHostedContextCapacity('kimi', 'kimi-k2.6', '{}'), outputTokenReserve: 16384 }])
    expect(plan.packets).toHaveLength(1)
    expect(plan.packets.flat().map(s => s.text).join('')).toBe(input)
    expect(plan.reconciliation).toHaveLength(0)
  })

})
