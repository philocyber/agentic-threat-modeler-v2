import { describe, expect, it } from 'vitest'
import {
  classifyInvalidDebateTurns,
  debateTurnRepairTask,
  includeOpponentInRepair,
} from '../debate-repair'

const own = 'CTRL-1 JWT validation is enabled on Kong. Only public routes are covered; internal paths still need verification.'
const opponent = 'Unsigned tokens still accepted on the users route when the plugin is disabled in staging.'

describe('invalid debate-turn classification', () => {
  it('flags a team that repeats its previous notes and a team that copies the opponent', () => {
    expect(classifyInvalidDebateTurns({
      current: [{ draftId: 'DRAFT-1', notes: own }],
      previousOwn: [{ draftId: 'DRAFT-1', notes: own }],
      opponent: [{ draftId: 'DRAFT-1', notes: opponent }],
    })).toMatchObject({ ids: ['DRAFT-1'], repeatedOwn: true, copiedOpponent: false })
    expect(classifyInvalidDebateTurns({
      current: [{ draftId: 'DRAFT-1', notes: opponent }],
      opponent: [{ draftId: 'DRAFT-1', notes: opponent }],
    })).toMatchObject({ ids: ['DRAFT-1'], copiedOpponent: true, repeatedOwn: false })
  })

  it('does not flag a substantive reply that shares a catalog identifier', () => {
    const red = 'SRC-0001 documents JWT validation. Residual risk is replay on unsigned staging tokens.'
    const blue = 'SRC-0001 names the gateway plugin. That citation does not prove replay protection exists here.'
    expect(classifyInvalidDebateTurns({
      current: [{ draftId: 'DRAFT-1', notes: blue }],
      opponent: [{ draftId: 'DRAFT-1', notes: red }],
      previousOwn: [{ draftId: 'DRAFT-1', notes: 'Authentication is enforced; route coverage requires verification.' }],
    }).ids).toEqual([])
  })

  it('asks a repair to answer the opponent when the only failure is self-repetition', () => {
    const repeated = classifyInvalidDebateTurns({
      current: [{ draftId: 'DRAFT-5', notes: own }],
      previousOwn: [{ draftId: 'DRAFT-5', notes: own }],
      opponent: [{ draftId: 'DRAFT-5', notes: opponent }],
    })
    expect(includeOpponentInRepair(repeated)).toBe(true)
    expect(debateTurnRepairTask(['DRAFT-5'], repeated)).toContain('repair ONLY for DRAFT-5')
    expect(debateTurnRepairTask(['DRAFT-5'], repeated)).toContain('repeated your previous turn')
    expect(includeOpponentInRepair(classifyInvalidDebateTurns({
      current: [{ draftId: 'DRAFT-1', notes: opponent }],
      opponent: [{ draftId: 'DRAFT-1', notes: opponent }],
    }))).toBe(false)
  })
})
