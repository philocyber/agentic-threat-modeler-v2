import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteDatabase } from '@/lib/db/sqlite'
import { systems, threatModels, threats } from '@/lib/db/schema.sqlite'
import { eq } from 'drizzle-orm'
import { createLocalProject } from '@/lib/workspace/local-project'
import { runWithWorkspace } from '@/lib/workspace/context'
import { closeWorkspaceStorage } from '@/lib/storage/context'
import { buildReviewerLearningSection } from '@/lib/agents/learning-context'
import {
  getConfirmedThreatExamples,
  getLearningStats,
  getRejectedThreatExamples,
  searchReviewedThreatKnowledge,
} from '../review-learning'

const originalRoot = process.env.AGENTICTM_WORKSPACE_ROOT
let testRoot: string | undefined
let workspaceDatabasePath: string | undefined

afterEach(async () => {
  if (workspaceDatabasePath) closeWorkspaceStorage(workspaceDatabasePath)
  workspaceDatabasePath = undefined
  if (testRoot) await rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  testRoot = undefined
  if (originalRoot === undefined) delete process.env.AGENTICTM_WORKSPACE_ROOT
  else process.env.AGENTICTM_WORKSPACE_ROOT = originalRoot
})

describe('review learning storage', () => {
  it('aggregates review stats and returns examples by status', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-learning-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Learning Project' })
    workspaceDatabasePath = join(project.path, project.database)
    const database = createSqliteDatabase(workspaceDatabasePath)

    try {
      await database.insert(systems).values({ id: 'sys_learning', name: 'Learning system' })
      await database.insert(threatModels).values({
        id: 'tm_learning',
        systemId: 'sys_learning',
        title: 'Learning Project',
        input: 'input',
        versionHash: 'b'.repeat(64),
        status: 'completed',
        totalThreats: 3,
      })
      await database.insert(threats).values([
        {
          id: 'thr_confirmed',
          threatModelId: 'tm_learning',
          title: 'SQL injection',
          component: 'API',
          description: 'Unsanitized query params',
          impact: 'Database records can be disclosed',
          mitigation: 'Use parameterized queries',
          reviewStatus: 'confirmed',
          userComments: 'Confirmed after reproducing against the search endpoint',
        },
        {
          id: 'thr_rejected',
          threatModelId: 'tm_learning',
          title: 'Generic XSS',
          component: 'UI',
          description: 'No HTML in this API',
          reviewStatus: 'rejected',
          reviewNotes: 'Out of scope',
        },
        {
          id: 'thr_pending',
          threatModelId: 'tm_learning',
          title: 'IDOR',
          component: 'API',
          description: 'Missing ownership check',
          reviewStatus: 'pending',
        },
      ])
    } finally {
      database.$client.close()
    }

    const stats = await runWithWorkspace(project, () => getLearningStats())
    expect(stats).toMatchObject({
      confirmed: 1,
      rejected: 1,
      pending: 1,
      reviewed: 2,
      examplesForNextRun: 0,
    })
    expect(stats.precision).toBe(0.5)

    expect(await runWithWorkspace(project, () => getConfirmedThreatExamples('sys_learning'))).toEqual([])
    expect(await runWithWorkspace(project, () => searchReviewedThreatKnowledge('search SQL query', 'sys_learning'))).toEqual([])

    const writable = createSqliteDatabase(workspaceDatabasePath)
    try {
      await writable.update(threats).set({ reviewStatus: 'confirmed', reviewNotes: 'Ownership check was reproduced' }).where(eq(threats.id, 'thr_pending'))
    } finally { writable.$client.close() }

    const confirmed = await runWithWorkspace(project, () => getConfirmedThreatExamples('sys_learning'))
    expect(confirmed).toHaveLength(2)
    expect(confirmed.map(example => example.title)).toContain('SQL injection')
    expect((await runWithWorkspace(project, () => getLearningStats('sys_learning'))).examplesForNextRun).toBe(3)

    const rejected = await runWithWorkspace(project, () => getRejectedThreatExamples('sys_learning'))
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reviewNotes).toBe('Out of scope')

    const relevant = await runWithWorkspace(project, () => searchReviewedThreatKnowledge('search SQL query', 'sys_learning'))
    expect(relevant).toHaveLength(1)
    expect(relevant[0]).toMatchObject({
      id: 'thr_confirmed',
      reviewStatus: 'confirmed',
      reviewNotes: 'Confirmed after reproducing against the search endpoint',
    })
  })

  it('isolates prior decisions by system and excludes incomplete or current runs', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-learning-scope-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Bank' })
    workspaceDatabasePath = join(project.path, project.database)
    const database = createSqliteDatabase(workspaceDatabasePath)
    try {
      await database.insert(systems).values([
        { id: 'financebot', name: 'FinanceBot' },
        { id: 'payments', name: 'Payments API' },
      ])
      await database.insert(threatModels).values([
        { id: 'finance_reviewed', systemId: 'financebot', title: 'Finance v1', input: 'input', versionHash: 'a'.repeat(64), status: 'completed', totalThreats: 1 },
        { id: 'payments_reviewed', systemId: 'payments', title: 'Payments v1', input: 'input', versionHash: 'b'.repeat(64), status: 'completed', totalThreats: 1 },
        { id: 'finance_partial', systemId: 'financebot', title: 'Finance partial', input: 'input', versionHash: 'c'.repeat(64), status: 'partial', totalThreats: 1 },
        { id: 'finance_mismatch', systemId: 'financebot', title: 'Finance missing rows', input: 'input', versionHash: 'd'.repeat(64), status: 'completed', totalThreats: 2 },
        { id: 'finance_no_reason', systemId: 'financebot', title: 'Finance no rationale', input: 'input', versionHash: 'e'.repeat(64), status: 'completed', totalThreats: 1 },
        { id: 'finance_archived', systemId: 'financebot', title: 'Finance archived', input: 'input', versionHash: 'f'.repeat(64), status: 'completed', totalThreats: 1, archivedAt: new Date() },
      ])
      await database.insert(threats).values([
        { id: 'finance_yes', threatModelId: 'finance_reviewed', title: 'Gateway bypass', description: 'Finance gateway bypass', reviewStatus: 'confirmed', reviewNotes: 'Verified in FinanceBot' },
        { id: 'payments_no', threatModelId: 'payments_reviewed', title: 'Gateway bypass', description: 'Payments gateway bypass', reviewStatus: 'rejected', reviewNotes: 'Payments has separate policy' },
        { id: 'finance_partial_no', threatModelId: 'finance_partial', title: 'Gateway bypass', description: 'Partial run', reviewStatus: 'rejected', reviewNotes: 'Partial result' },
        { id: 'finance_mismatch_no', threatModelId: 'finance_mismatch', title: 'Gateway bypass', description: 'Missing second finding', reviewStatus: 'rejected', reviewNotes: 'Incomplete persistence' },
        { id: 'finance_no_reason_no', threatModelId: 'finance_no_reason', title: 'Gateway bypass', description: 'No rationale', reviewStatus: 'rejected' },
        { id: 'finance_archived_no', threatModelId: 'finance_archived', title: 'Gateway bypass', description: 'Archived', reviewStatus: 'rejected', reviewNotes: 'Historical' },
      ])
    } finally { database.$client.close() }

    expect((await runWithWorkspace(project, () => searchReviewedThreatKnowledge('Gateway bypass', 'financebot'))).map(example => example.id)).toEqual(['finance_yes'])
    expect((await runWithWorkspace(project, () => searchReviewedThreatKnowledge('Gateway bypass', 'payments'))).map(example => example.id)).toEqual(['payments_no'])
    expect(await runWithWorkspace(project, () => searchReviewedThreatKnowledge('Gateway bypass', 'financebot', 5, 'finance_reviewed'))).toEqual([])
    expect(await runWithWorkspace(project, () => getRejectedThreatExamples('financebot'))).toEqual([])
    expect(await runWithWorkspace(project, () => getConfirmedThreatExamples(''))).toEqual([])
    const prompt = await runWithWorkspace(project, () => buildReviewerLearningSection('financebot', 'current-run'))
    expect(prompt).toContain('prior run finance_reviewed')
    expect(prompt).toContain('current architecture and current-run analysis first')
    expect(prompt).not.toContain('Payments has separate policy')
  })

  it('uses run totals for active legacy analyses without persisted threat rows', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'agentictm-learning-legacy-'))
    process.env.AGENTICTM_WORKSPACE_ROOT = testRoot
    const project = await createLocalProject({ name: 'Legacy Learning Project' })
    workspaceDatabasePath = join(project.path, project.database)
    const database = createSqliteDatabase(workspaceDatabasePath)

    try {
      await database.insert(threatModels).values([
        {
          id: 'tm_legacy_active',
          title: 'Legacy active run',
          input: 'input',
          versionHash: 'c'.repeat(64),
          status: 'completed',
          totalThreats: 7,
        },
        {
          id: 'tm_legacy_archived',
          title: 'Legacy archived run',
          input: 'input',
          versionHash: 'd'.repeat(64),
          status: 'completed',
          totalThreats: 11,
          archivedAt: new Date(),
        },
        {
          id: 'tm_legacy_failed',
          title: 'Legacy failed run',
          input: 'input',
          versionHash: 'e'.repeat(64),
          status: 'failed',
          totalThreats: 13,
        },
      ])
    } finally {
      database.$client.close()
    }

    const stats = await runWithWorkspace(project, () => getLearningStats())
    expect(stats.pending).toBe(7)
  })
})
