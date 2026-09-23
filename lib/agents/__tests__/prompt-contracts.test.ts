import { describe, expect, it } from 'vitest'
import { SYSTEM_PROMPT as ARCHITECTURE_PROMPT } from '@/lib/agents/architecture-parser'
import {
  EMISSION_SYSTEM_PROMPT as VALIDATOR_EMISSION_PROMPT,
  EVIDENCE_SYSTEM_PROMPT as VALIDATOR_EVIDENCE_PROMPT,
} from '@/lib/agents/dread-validator'
import {
  EMISSION_SYSTEM_PROMPT as STRIDE_EMISSION_PROMPT,
  EVIDENCE_SYSTEM_PROMPT as STRIDE_EVIDENCE_PROMPT,
} from '@/lib/agents/stride-analyst'
import { EVIDENCE_REQUIREMENT } from '@/lib/agents/base'
import {
  BLUE_EVIDENCE_PROMPT,
  JUDGE_PROMPT,
  RED_EVIDENCE_PROMPT,
  RED_REPLY_EVIDENCE_PROMPT,
} from '@/lib/agents/debate'
import { priorityBandsPromptText } from '@/lib/models/scoring'
import { DEFAULT_CONFIDENCE_THRESHOLD } from '@/lib/agents/dedup'

/**
 * These are drift guards, not style checks: each assertion pins a prompt
 * property the pipeline's code depends on. If someone rewrites a prompt and
 * drops one of these, the failure names what broke.
 */
describe('architecture parser prompt', () => {
  it('does not ask the model for diagrams — they are generated deterministically', () => {
    expect(ARCHITECTURE_PROMPT).not.toMatch(/mermaid/i)
    expect(ARCHITECTURE_PROMPT).not.toMatch(/classDef|subgraph|flowchart/i)
    expect(ARCHITECTURE_PROMPT).toMatch(/Do NOT produce diagrams/i)
  })

  it('stays small enough to leave room for the document itself', () => {
    expect(ARCHITECTURE_PROMPT.length).toBeLessThan(7_000)
  })

  it('still asks for the structured facts the diagrams are built from', () => {
    for (const field of ['components', 'dataFlows', 'trustBoundaries', 'dataStores', 'apiEndpoints']) {
      expect(ARCHITECTURE_PROMPT).toContain(field)
    }
  })
})

describe('DREAD validator prompt', () => {
  it('carries ceiling rules for documented controls, not only escalation rules', () => {
    expect(VALIDATOR_EMISSION_PROMPT).toContain('CEILING RULES')
    expect(VALIDATOR_EMISSION_PROMPT).toMatch(/R <= 5/)
  })

  it('anchors the low end of the scale as well as the high end', () => {
    expect(VALIDATOR_EMISSION_PROMPT).toContain('LOW-RISK ANCHORS')
    // At least one calibrated example below the medium threshold.
    expect(VALIDATOR_EMISSION_PROMPT).toMatch(/\*\*3\.\d\*\*/)
    expect(VALIDATOR_EMISSION_PROMPT).toMatch(/almost always wrong/i)
  })

  it('states the priority bands exactly as the code computes them', () => {
    for (const line of priorityBandsPromptText().split('\n')) {
      expect(VALIDATOR_EMISSION_PROMPT).toContain(line)
    }
  })

  it('uses debate reasoning without forcing its severity band', () => {
    expect(VALIDATOR_EMISSION_PROMPT).toContain('DEBATE RULING')
    expect(VALIDATOR_EMISSION_PROMPT).toMatch(/Do not work backwards from finalVerdict/i)
  })

  it('asks the evidence phase to score against the documented controls it now receives', () => {
    expect(VALIDATOR_EVIDENCE_PROMPT).toMatch(/DOCUMENTED CONTROLS listed with the batch/i)
    expect(VALIDATOR_EVIDENCE_PROMPT).toMatch(/precondition/i)
  })
})

describe('STRIDE analyst prompt', () => {
  it('orders the work from trust-boundary crossings inward', () => {
    expect(STRIDE_EVIDENCE_PROMPT).toMatch(/CROSS a trust boundary/i)
    expect(STRIDE_EVIDENCE_PROMPT).toMatch(/externally\s+reachable entry point/i)
  })

  it('forbids a single-category monoculture and allows explicit non-applicability', () => {
    expect(STRIDE_EVIDENCE_PROMPT).toContain('COVERAGE DISCIPLINE')
    expect(STRIDE_EVIDENCE_PROMPT).toMatch(/more than half your candidates share a\s+single STRIDE category/i)
    expect(STRIDE_EVIDENCE_PROMPT).toMatch(/not applicable because/i)
  })

  it('keeps coverage bookkeeping out of the emitted threat list', () => {
    expect(STRIDE_EMISSION_PROMPT).toMatch(/Coverage:.*never emit them as threats/is)
  })
})

describe('shared evidence requirement', () => {
  it('defines what a confidence score means at each level', () => {
    expect(EVIDENCE_REQUIREMENT).toContain('CONFIDENCE CALIBRATION')
    expect(EVIDENCE_REQUIREMENT).toMatch(/0\.90-1\.00/)
    expect(EVIDENCE_REQUIREMENT).toMatch(/0\.70-0\.89/)
    expect(EVIDENCE_REQUIREMENT).toMatch(/0\.55-0\.69/)
  })

  it('quotes the same cut-off the pipeline actually filters on', () => {
    expect(EVIDENCE_REQUIREMENT).toContain(String(DEFAULT_CONFIDENCE_THRESHOLD))
  })

  it('explains why the number matters, so it is not treated as decoration', () => {
    expect(EVIDENCE_REQUIREMENT).toMatch(/red\/blue debate/i)
  })
})

describe('debate prompts', () => {
  it('grounds red and blue in the architecture dossier, not RAG-as-proof', () => {
    expect(RED_EVIDENCE_PROMPT).toMatch(/SYSTEM ARCHITECTURE/)
    expect(RED_EVIDENCE_PROMPT).toMatch(/RAG is for techniques/)
    expect(BLUE_EVIDENCE_PROMPT).toMatch(/fact ledger/)
    expect(BLUE_EVIDENCE_PROMPT).toMatch(/does not prove a control exists/)
  })

  it('reserves invalid and keeps a rebuttal turn for contested findings', () => {
    expect(RED_EVIDENCE_PROMPT).toMatch(/DRAFT-n/)
    expect(RED_REPLY_EVIDENCE_PROMPT).toMatch(/rebuttal/i)
    // The judge closes every supplied finding now, so it no longer speaks of a
    // "contested" subset. The invariant that survived the widening: it must not
    // re-label what the teams already agreed on, and process status is not a
    // conclusion.
    //   previously: /contested/ and /Do not reopen/
    expect(JUDGE_PROMPT).toMatch(/do not reopen labels/i)
    expect(JUDGE_PROMPT).toMatch(/disagree/i)
    expect(JUDGE_PROMPT).toMatch(/do not write process status/i)
  })
})
