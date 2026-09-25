import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalProject } from '@/lib/workspace/local-project'
import { runWithWorkspace } from '@/lib/workspace/context'
import { closeAllWorkspaceStorage, getStorage } from '@/lib/storage/context'
import { getRunArtifactText } from '@/lib/storage/artifacts'
import { listThreatModels, listThreats } from '@/lib/storage/threat-models'
import { createSourceEvidence } from '@/lib/architecture/source-evidence'
import { importDemoScans } from '../import-demo-scans'
import ollama from '@/demo-scans/ollama.json'
import cursor from '@/demo-scans/cursor.json'
import kimi from '@/demo-scans/kimi.json'

const originalRoot = process.env.AGENTICTM_WORKSPACE_ROOT
let testRoot: string | undefined

afterEach(async () => {
  closeAllWorkspaceStorage()
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
  testRoot = undefined
  if (originalRoot === undefined) delete process.env.AGENTICTM_WORKSPACE_ROOT
  else process.env.AGENTICTM_WORKSPACE_ROOT = originalRoot
})

describe('bundled demo scans', () => {
  it('imports exactly three completed runs with verified reports and no model execution', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'argus-demos-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Demo review' })
    await runWithWorkspace(project, async () => {
      expect(await importDemoScans()).toEqual({ imported: 3, existing: 0 })
      expect(await importDemoScans()).toEqual({ imported: 0, existing: 3 })
      const runs = await listThreatModels({ page: 1, limit: 20 })
      expect(runs.map((run) => [run.systemName, run.totalThreats, run.status, run.isDemo])).toEqual([
        ['Chatbot - FinanceBot (Local Ollama)', 7, 'completed', true],
        ['Chatbot - FinanceBot (Cursor)', 15, 'completed', true],
        ['Chatbot - FinanceBot (Kimi)', 10, 'completed', true],
      ])
      for (const scan of [ollama, cursor, kimi]) {
        expect(await listThreats(scan.model.id)).toHaveLength(scan.threats.length)
        expect(await getRunArtifactText(scan.model.id, 'report')).toBe(scan.report)
        expect(scan.model.input).toContain('Classification: Synthetic — Public Demo')
        expect(scan.model.input).not.toContain('Classification: Internal — Confidential')
        const storedSections = scan.model.architecture_json.sourceEvidence.sections
        const regenerated = createSourceEvidence(scan.model.input).sections
        expect(storedSections.map((section) => [section.id, section.start, section.end, section.text, section.fingerprint]))
          .toEqual(regenerated.map((section) => [section.id, section.start, section.end, section.text, section.fingerprint]))
      }
      const storage = getStorage()
      if (storage.kind !== 'sqlite') throw new Error('Expected SQLite workspace')
      expect(storage.db.$client.prepare("SELECT count(*) AS count FROM threat_models WHERE status IN ('pending', 'running')").get()).toEqual({ count: 0 })
    })
  })
})
