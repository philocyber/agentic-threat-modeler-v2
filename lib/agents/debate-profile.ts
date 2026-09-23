import type { LLMProvider } from '@/lib/llm/providers'

/**
 * COORDINATION: Kimi / Ollama / Cursor agents (do not delete this block)
 *
 * Shared contract: one table, three workflows. Edit your own entry. Do not
 * "harmonize" another provider back to yours; the failure modes differ.
 *
 *   Ollama  quality-max: two_phase, judgeCoverage all, interimConclusions,
 *           verifyRepairs. A local 9B copies Blue onto Red and cannot be
 *           trusted to leave a usable close in Blue's notes.
 *   Kimi    call-min:    embedded, judgeCoverage contested, no interim, no
 *           second repair. v15 was 75 hosted calls / ~38 min with 15/15
 *           agreed; an all-finding judge would have added cost for no
 *           label change. Agreed findings close from Blue via
 *           closeAgreedFromBlue in debate.ts.
 *   Cursor  embedded + outputTokenReserve 4096, verifyRepairs on, and
 *           replayAgreedFindings false. v36 copied the last batch in round 2
 *           (3 unresolved). v37 replayed all 14; Grok copied/repeated and
 *           left 9 unresolved. judgeCoverage stays `all` for remaining
 *           contested IDs. Do not copy Kimi's contested shortcut.
 *
 * Wiring lives in debate.ts (evidenceMode, judgeIds, closeAgreedFromBlue,
 * verifyRepairs, interim judge) and builder.ts (candidateCap, batchSize).
 */
/**
 * Per-provider debate tuning.
 *
 * Inference economics differ enough between a local 9B model and a hosted
 * frontier model that one set of knobs cannot serve both: a local run needs
 * small batches, one batch in flight and extra repair attempts, while a hosted
 * run can afford wide batches but has to reserve output tokens. Keeping the
 * knobs in one table means a provider is tuned by editing one entry instead of
 * hunting provider ternaries across the pipeline.
 */
export type DebateProfile = {
  /** Highest-confidence candidates admitted to the debate. */
  candidateCap: number
  /** Candidates per Red, Blue and Judge call. */
  batchSize: number
  /** Batches in flight at once. */
  batchConcurrency: number
  /**
   * Hosted frontier models can reason directly over the source-backed dossier.
   * Local models retain a separate evidence pass before structured emission.
   */
  evidenceMode: 'embedded' | 'two_phase'
  /**
   * Which drafts the final-round judge writes a conclusion for.
   *
   * `all` (Ollama / default): every finding gets a judge call. Local inference
   * is cheap in money; the 9B model also cannot be trusted to leave a usable
   * close in Blue's notes.
   *
   * `contested` (Kimi): the judge only sees disagreements and dual-invalid
   * proposals. Agreed findings still get a written close from Blue's last
   * notes, not a second hosted call. v15 agreed on 15/15; an all-finding judge
   * would have added frontier calls for no label change.
   *
   * Cursor: leave `all` unless that agent opts in. Do not silently inherit
   * Kimi's contested shortcut onto Cursor.
   */
  judgeCoverage: 'contested' | 'all'
  /** Close each finding in provisional rounds too, so no round ends unstated. */
  interimConclusions: boolean
  /** Re-check a repaired turn and spend a second repair when it still copies. */
  verifyRepairs: boolean
  /**
   * Replay already-agreed findings in later configured rounds.
   *
   * Default true: runDebateSession still runs every round, and each round
   * still sees every candidate. Ollama v35 needed that second challenge.
   * Kimi v15 survived it. Cursor v36/v37 did not: Grok restates the prior
   * turn once the opponent's prose is in context, and copy detection then
   * marks the card unresolved.
   *
   * false (Cursor): later rounds keep only disagreed or quality-failed IDs.
   * Agreed cards carry forward with a Blue close. This is not a global
   * wire-up of unresolvedDebateCandidates(); that helper still requires
   * judgeNotes and would drop every provisional Cursor card.
   */
  replayAgreedFindings: boolean
  /** 3-gram containment at or above which one turn counts as copying another. */
  copyContainment: number
  /** Output tokens withheld from the context budget for the emission call. */
  outputTokenReserve?: number | undefined
}

/*
 * Invariants every profile preserves. These are correctness rather than tuning,
 * so a provider entry may not opt out of them:
 *
 *  1. Process-status text is never written as a finding conclusion. The canned
 *     sentences are listed in debate-quality.ts; formatDebateRoundsMarkdown
 *     emits nothing rather than filler, and writtenFindingConclusion() strips
 *     them from transcripts saved before that rule existed.
 *  2. A judge entry for a finding the teams already agreed on is `ratified`:
 *     its prose becomes the conclusion and its labels are discarded, so
 *     widening judgeCoverage can never overturn a consensus.
 *  3. Display IDs are assigned one-to-one (matchThreats in debate-format.ts).
 *     That ID is the join key used by lib/evaluation/threat-quality.ts, so a
 *     collision silently drops findings from the quality evaluation.
 *  4. Copy detection uses containment, not symmetric overlap. Raise
 *     copyContainment per provider if repairs are too eager, but a symmetric
 *     score is defeated by a padded restatement.
 *
 * Baseline that set these defaults (ollama, 8 candidates over 2 rounds):
 * dread_validator 703s, debate 561s, synthesis 479s, attack_tree 208s,
 * stride 164s, pasta 143s, parser 27s. The debate is a quarter of the run and
 * the validator is the larger target. Within the debate, 271s of the 561s were
 * recorded model calls; the remainder is the evidence phase, which telemetry
 * does not record separately.
 *
 * The same transcript is why `replayAgreedFindings` exists. Red/Blue 3-gram
 * containment was <=0.51 in round 1 and 0.58-0.83 in round 2: once a team held
 * the opponent's prose it began restating it, so replaying a settled finding
 * bought nothing and manufactured the copying. Carry-forward keys on team
 * agreement with empty qualityIssues rather than on judgeNotes, because an
 * interim close is commentary and profiles without one would never qualify.
 */

/**
 * Hosted providers with generous context. Each provider below states only what
 * it changes, so a new provider inherits a working debate by default.
 */
const BASE_PROFILE: DebateProfile = {
  candidateCap: 25,
  batchSize: 3,
  batchConcurrency: 3,
  evidenceMode: 'two_phase',
  judgeCoverage: 'all',
  interimConclusions: false,
  verifyRepairs: false,
  replayAgreedFindings: true,
  copyContainment: 0.5,
}

const PROFILES: Partial<Record<LLMProvider, Partial<DebateProfile>>> = {
  // A local 9B judge is cheap in money and expensive in wall clock, so it gets
  // the widest coverage the design allows: every finding is closed in every
  // round, and a turn that copies the opponent is repaired until it stops.
  ollama: {
    candidateCap: 8,
    batchConcurrency: 1,
    evidenceMode: 'two_phase',
    interimConclusions: true,
    verifyRepairs: true,
  },
  // Kimi: token throughput and billing stalls are the limit, not context. A
  // 15-finding two-phase run over batches of 3 cost 75 calls, so this entry
  // trades the quality-max flags for wider batches and embedded evidence.
  // `contested` coverage would leave an agreed finding with no conclusion at
  // all, so closeAgreedFromBlue() supplies a ratified close from Blue's own
  // last notes; that costs nothing extra, because a fully agreed batch makes
  // no judge call to append to. The round-level judgeSummary stays model-only
  // so an all-agreed batch does not grow a synthetic banner.
  kimi: {
    batchSize: 5,
    batchConcurrency: 1,
    evidenceMode: 'embedded',
    judgeCoverage: 'contested',
    // Stated rather than inherited, so raising a BASE default cannot quietly
    // add calls back to this provider.
    interimConclusions: false,
    verifyRepairs: false,
  },
  // Cursor's verified Grok context processes wider batches straight from the
  // dossier; output room is reserved because the adapter does not constrain it.
  // Replaying settled findings was the failure here: with every candidate
  // replayed, Grok restated agreed cards rather than answering, leaving most
  // of them unresolved even with a second repair pass. Only genuinely
  // contested IDs are replayed, and those still get full judge coverage.
  cursor: {
    batchSize: 5,
    evidenceMode: 'embedded',
    outputTokenReserve: 4_096,
    verifyRepairs: true,
    replayAgreedFindings: false,
  },
}

export function debateProfileFor(provider: string): DebateProfile {
  return { ...BASE_PROFILE, ...PROFILES[provider as LLMProvider] }
}
