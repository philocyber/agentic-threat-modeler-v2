import { describe, it, expect, beforeAll } from 'vitest'
import { config as loadEnv } from 'dotenv'
import { z } from 'zod'
import { getLLM } from '@/lib/llm/factory'
import { getConfig } from '@/lib/config'
import { invokeStructured, selectStructuredMechanism } from '@/lib/llm/structured'
import { DreadValidatorOutputSchema } from '@/lib/agents/dread-validator'

/**
 * Opt-in check against a live provider. It spends real credit, so it only runs
 * with RUN_LIVE_PROVIDER=1:
 *
 *   RUN_LIVE_PROVIDER=1 npx vitest run lib/llm/__tests__/live-provider.test.ts
 *
 * It exists because the failure it guards was invisible offline: the request
 * succeeded, the provider ignored the malformed constraint, and the run only
 * fell over minutes later inside a paid pipeline. This exercises the same
 * factory, model tier and schema the debate judge uses.
 */
const live = process.env.RUN_LIVE_PROVIDER === '1'

const Verdict = z.enum(['critical', 'high', 'medium', 'low', 'invalid'])
const Disposition = z.enum([
  'applicable',
  'conditional',
  'control_verification_needed',
  'mitigated',
  'invalid',
])
const JudgeSchema = z.object({
  summary: z.string(),
  convergenceSignal: z.boolean(),
  threatAssessments: z.array(
    z.object({
      draftId: z.string(),
      threatDescription: z.string(),
      verdict: Verdict,
      disposition: Disposition.optional(),
      notes: z.string(),
      finalVerdict: Verdict,
    }),
  ),
})

const DRAFT_COUNT = 25
const drafts = Array.from(
  { length: DRAFT_COUNT },
  (_, i) =>
    `DRAFT-${i + 1}. [STRIDE] component=svc-${i % 5}; confidence=0.8; ` +
    `description=Attacker abuses weak input validation on path ${i} to reach an internal service; ` +
    `impact=data exposure; evidence=none`,
).join('\n')

describe.skipIf(!live)('live provider — the judge phase produces a valid answer', () => {
  beforeAll(() => {
    loadEnv({ path: '.env.local' })
  })

  it('returns one assessment per draft through the real code path', async () => {
    const config = getConfig()
    // 'quick' is the tier the debate judge runs on (lib/graph/builder.ts).
    const llm = getLLM(config, 'quick')
    // Which provider actually answered decides what this run proves, so it is
    // reported instead of assumed. Override with LLM_PROVIDER=kimi to retarget.
    console.log(`[live] provider=${config.llm.provider} mechanism=${selectStructuredMechanism(llm)}`)
    expect(selectStructuredMechanism(llm)).not.toBe('prompt-fallback')

    const out = await invokeStructured({
      llm,
      schema: JudgeSchema,
      systemPrompt:
        'You are an independent security judge. Produce a final severity verdict and ' +
        'applicability disposition for every supplied DRAFT threat. Preserve every draftId exactly.',
      userMessage: `Round 1. Threats under review:\n${drafts}\n\nRED TEAM: all exploitable.\nBLUE TEAM: controls exist.`,
      agentName: 'DebateJudge',
      timeoutMs: 300_000,
    })

    expect(out.threatAssessments.length).toBe(DRAFT_COUNT)
    expect(new Set(out.threatAssessments.map((a) => a.draftId)).size).toBe(DRAFT_COUNT)
    expect(out.summary.length).toBeGreaterThan(0)
  }, 300_000)

  // The other agent that degraded on the same run. Its schema carries
  // `.transform()` and a nested optional object, so it exercises both the
  // conversion fallback and the strict rewrite.
  it('validates DREAD scores against the real validator schema', async () => {
    const config = getConfig()
    const llm = getLLM(config, 'deep')
    console.log(`[live] provider=${config.llm.provider} mechanism=${selectStructuredMechanism(llm)}`)

    const out = await invokeStructured({
      llm,
      schema: DreadValidatorOutputSchema,
      systemPrompt:
        'You are a security risk management specialist. Assign DREAD scores (0-10 each, ' +
        'plus a total) to every supplied threat and return them unchanged otherwise.',
      userMessage:
        'Threats:\n' +
        'THR-001 | Shared-tenant identity provider token confusion | A token minted for one ' +
        'tenant is accepted by another tenant boundary.\n' +
        'THR-002 | Presigned upload URL reuse | An expired-but-valid URL is replayed to ' +
        'overwrite an object.',
      agentName: 'DreadValidator',
      timeoutMs: 300_000,
    })

    expect(out.validations).toHaveLength(2)
    for (const validation of out.validations) {
      // The five dimensions are what the pipeline consumes; the total it
      // recomputes itself, and providers do return the sum (Kimi answered 38).
      for (const dimension of [
        validation.dread.damage,
        validation.dread.reproducibility,
        validation.dread.exploitability,
        validation.dread.affectedUsers,
        validation.dread.discoverability,
      ]) {
        expect(dimension).toBeGreaterThanOrEqual(0)
        expect(dimension).toBeLessThanOrEqual(10)
      }
      expect(validation.title.length).toBeGreaterThan(0)
    }
  }, 300_000)
})
