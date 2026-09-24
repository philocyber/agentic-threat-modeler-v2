# Context, document coverage, and finding quality

This guide describes current behavior,
not a claim of exhaustive threat detection. Product summary: `/docs#context-coverage`
and `/docs#finding-quality`. Output configuration: [LLM token limits](llm-token-limits.md).

## Why a large model window is not enough

The model context window is the capacity of one invocation. It is not a shared
memory across architecture extraction, analysts, debate, synthesis and validation.
Each stage only knows the material included in its own request. Output token caps
limit generation; application character budgets limit what is passed forward.
Increasing an output cap or choosing a larger model does not remove those budgets.
Cumulative run tokens count repeated prompts and outputs, not unique source coverage.

Source and notes budgets now use configured model capacity; external RAG evidence
remains bounded separately. These budgets are not calibrated proof of semantic
coverage. Verified Kimi models use the checked capacity catalog; other hosted models need
explicit configuration to use a larger window. Unknown aliases are not inferred.

Evidence notes must also fit the output allowance of the model writing them,
which can be smaller than the model used for structured emission. The requested
prose budget is capped conservatively at two characters per reserved output token,
in addition to the context budget. This is a prompt allowance, not a tokenizer
guarantee. Source passages remain complete, and provider-reported output
truncation still fails the phase. Shared pipeline clients do not force JSON on
prose evidence calls; structured emission applies its schema per invocation.

Analyst candidate counts are upper bounds, with no minimum quota. A source that
supports fewer distinct candidates must not be padded. Structured retries receive
the full rejected object as untrusted data alongside validation feedback, so the
model can correct the actual response rather than regenerate from error paths
alone. Original source context and the normal context guard still apply.

## Source-preserving pipeline

- **Admission is unchanged:** up to 20 analysis upload IDs, 10 MiB per upload,
  and 500,000 JavaScript string code units of combined analysis input. Knowledge
  ingestion is separate. The API error still calls string units “bytes”.
- **Original evidence:** new architectures persist `sourceEvidence`, containing
  every character of the secret-redacted input. SRC IDs, inherited headings and
  start/end offsets identify source windows. Offsets refer to redacted text.
  Windows target 3,000 characters and preserve headings and paragraph boundaries
  where possible. Long paragraphs are split without discarding text.
- **Model-aware planning:** the parser and analysts pack complete windows into
  the available context. Small bundles travel intact in one request. Larger
  bundles use multiple complete-source passes; every source window is delivered.
  Prompt overhead and output capacity are reserved before packing. Estimates use
  approximately 2.5 characters per token, not an exact tokenizer. Actual context
  overflow is still rejected by the invocation guard.
- **Capacity configuration:** Ollama uses its configured quick/deep `NUM_CTX`.
  Hosted models use exact model-name capacities from `MODEL_CONTEXT_WINDOWS`, a
  JSON object in the environment, then verified Kimi defaults (K2.6: 262,144;
  K3: 1,000,000), then a conservative 32,768-token planning window when unlisted. This fallback is not a vendor capacity claim. Output reserves
  use the selected tier's output cap. Capacity is not discovered automatically
  from provider catalogs; verify it before configuring an override. Restart after
  changes. Context settings participate in cache and resume fingerprints.
- **Complete ledger:** new source-backed runs retain all extracted source statements
  in the fact ledger. Prompts use original SRC passages instead of repeating this
  entire ledger. Historical architectures without source metadata retain the old
  sampled-ledger behavior; they are not backfilled with invented coverage.
- **Cross-document checks:** when source groups differ, additional analyst passes
  jointly inspect sections sharing an exact parsed component name or the endpoints of a parsed data flow. Original source
  lookup can retrieve matching and adjacent windows to resolve a `SOURCE_GAP` in
  analyst notes. One explicit follow-up is supported per two-phase call; its source
  passages reach both revised notes and structured emission. This is deterministic
  lexical retrieval, not guaranteed alias or semantic dependency discovery.
  Oversized shared-component groups are reconciled through
  pairs of smaller source groups. Every pair of related sections is delivered
  together in a primary or reconciliation pass, with its original text intact.
  Redundant subset passes are removed. This avoids requiring every mention of a
  frequently named system to fit in one call, but adds inference calls and does
  not certify reasoning across three or more groups simultaneously.
  Analyst phase timeouts scale with the planned pass count, up to the global
  run budget. Individual call timeouts and the original global deadline remain
  enforced. Source-pass start/completion logs expose progress within an analyst.
- **Quotation checks:** analyst architecture excerpts must match their claimed original
  SRC section. New analyst emissions validate original quotations and repeated
  candidates inside the structured-response schema, so a failed check supplies
  concrete feedback to the bounded retry. RAG background alone cannot replace an
  original architecture anchor. Matching excerpts receive canonical section
  references. Later stages and historical artifacts retain the verification flag
  and 0.69 existence-confidence cap when an original anchor cannot be verified.
  An exact quote proves provenance, not that the claimed risk follows.
- **Finding review:** debate, synthesis and DREAD receive original source context.
  If the whole bundle cannot fit, source IDs, component matches and exact excerpts
  select related sections, including adjacent qualifications. If broad component
  matches exceed the budget, an additional model pass classifies every original
  section as relevant, uncertain or irrelevant to the candidate batch. Missing,
  duplicate or invented classifications fail coverage. Relevant and uncertain
  sections, their neighbors, and cited sections with their neighbors are retained
  in full. This is a relevance judgment, not proof of semantic completeness.
  If that retained context still cannot fit, the call fails explicitly instead
  of clipping required passages. Large synthesis runs gather evidence per batch
  when a global source context cannot fit; candidate reconciliation still runs
  across the resulting batch outputs. Existing stage recovery preserves prior
  results with errors. The extra source review adds local inference calls.
- **Notes and qualifications:** source-backed analyst/debate/validator notes use
  available-context budgets. Oversized returned notes are not block-trimmed; the
  context guard rejects overflow. Provider-reported truncation of evidence notes
  or revisions also blocks emission, rather than producing findings from cut-off notes. Debate source excerpts, DREAD impact, mitigation
  and preconditions are no longer shortened by the old 200/220-character and
  three-item caps. Source-backed calls cannot use head/tail compaction.
- **Coverage gates:** failed or unattempted architecture sections block analysts.
  Incomplete enabled-analyst delivery blocks debate. The architecture checkpoint
  retains source evidence and failed extraction IDs; the pre-debate checkpoint
  records successful per-analyst delivery counts. Each completed analyst now saves
  its findings and delivered source IDs together in one atomic checkpoint. Resume
  restores those IDs before deciding which stages can be reused. When recorded
  delivery is missing or incomplete, that analyst and dependent downstream work
  are repeated to establish coverage. Historical array checkpoints remain readable;
  an empty findings array alone does not prove source delivery.
- **Visible coverage:** Results → Architecture shows extraction mode, failed source
  windows, successful analyst delivery counts and expandable original passages.
  These measure delivery, not model understanding or exhaustive threat detection.
- **RAG remains selective:** external knowledge budgets are 9,000 characters for
  analysts, 8,000 for Red/Blue, 10,000 for synthesis and 6,500 for validation;
  passages are capped at 2,400 characters and router queries at 40 per run. These
  bounds govern supporting knowledge, not retention of the supplied architecture.

Sources of truth: `lib/architecture/source-evidence.ts`,
`lib/agents/source-analysis.ts`, `lib/agents/architecture-parser.ts`,
`lib/agents/shared.ts`, `lib/agents/base.ts`, `lib/agents/debate-dossier.ts`,
`lib/agents/dread-context.ts`, `lib/agents/dread-validator.ts`,
`lib/agents/threat-synthesizer.ts`, `lib/graph/builder.ts`,
`lib/llm/context-guard.ts`, `lib/llm/factory.ts`, and `lib/runs/run-manifest.ts`.

## What six architecture Markdown files mean

Six files of 20,000 characters total 120,000 characters. They fit the analysis
admission limit. With sufficient configured model context, the original bundle
can be delivered together. With smaller context, every source window is analyzed
in a group and shared-component relationships receive additional review. This can
require more calls; it does not imply constant scan cost.

A production rule in file six qualifying a workflow in file one is retained in
original source evidence. Exact component matches and requested source lookups can
bring both together. Undeclared aliases, implicit dependencies and model reasoning
mistakes remain possible. Accepted, extracted, delivered and understood are still
different states. No completed scan certifies that every attack path was assessed.

## Quality and scoring behavior

- Separate actual system/dependency components from investigated, adjacent, proposed
  or historical context. Explicitly excluded contextual components are removed from
  the structured analyst scope; original passages retain the evidence needed to
  interpret those classifications. Unclassified components still require review.
- Citation URLs do not establish TLS, and unverified documentation or parser defaults
  do not establish a missing security control. Unknown configurations display as unknown.
- Essential unverified attack preconditions cap candidate existence-confidence at
  0.69 and mark control verification where detected. This is separate from the
  potential impact if the scenario is true; it is not a completeness guarantee.
- Dedup also checks shared attack mechanisms and trace evidence. Merged methodology
  lineage is retained; there is no promise that all semantic duplicates are removed.
- DREAD is the arithmetic average of five independently assessed dimensions, rounded
  to one decimal. Bands: Low below 4.0; Medium 4.0–6.4; High 6.5–7.9; Critical 8.0–10.
  Missing/invalid scores are unscored, not default Medium or numeric zero risk.
  Results show dimensions, score status and conditional interpretation where applicable.
  Identical severity bands are possible and do not alone establish a scoring bug.
- Persisted progress events preserve phase counts on reload. Architecture diagrams
  prioritize finding-linked components and visibly mark omitted graph detail.
- Existing run evidence is historical. Presentation/integrity fixes can affect how it
  displays; corrected generation requires a new run. The prompt version is bumped to
  prevent reuse of incompatible old checkpoints.

## Before paying for a new large run

1. Review the saved Run inputs bundle: all intended files/text, correct target and
   scope, model/provider snapshot, and no accidentally omitted upload.
2. Inspect the architecture artifact for failed-section notes, statement sampling,
   missing components, trust boundaries, flows and cross-document security rules.
3. Define a short expected-evidence checklist with references to each document,
   including a late-file rule and at least one relationship spanning documents.
   This is a manual check today, not an implemented automatic gate.
4. Hold inputs and model selection constant when comparing pipeline changes. One
   debate round is a cheaper quality experiment, not a recommended exhaustive audit.
5. Compare evidence retention, unsupported assumptions, duplicate mechanisms,
   conditional confidence and scoring rationale before considering more rounds.

## Validation and remaining limits

The checked-in six-document fixture covers a late-file permission rule, a
cross-document workflow, a historical administrator credential, an adjacent tool
and contradictory JWT claims. Deterministic and mocked-model tests check exact
source retention, multi-pass delivery, context overflow, original evidence in
review, and coverage gates. They do not establish production-model accuracy.

Qwen2/Qwen3 models exposing the `gpt2` / `qwen2` GGUF tokenizer through Ollama now
use their installed vocabulary, merge rules and special tokens for source sizing
and final message checks. Metadata is loaded locally through `/api/show`; source
text is not sent to a tokenizer service. Prompt framing, retrieval and output
still require reserved space. Unsupported tokenizers retain approximate sizing.
Set `OLLAMA_QUICK_NUM_CTX` and `OLLAMA_DEEP_NUM_CTX` within the installed model's
reported native capacity. This workspace's `qwen3:8b` reports 40,960 tokens;
that value is not a universal limit for other models. Context changes invalidate
incompatible resume fingerprints and require a fresh run.

Remaining work includes tokenizer support for other model families, automatic provider capacity
discovery, semantic/alias dependency resolution, measured token budgets, and blinded comparison of live models on labeled multi-document
cases. Architecture and RAG quotations are checked for contiguous excerpts and whether they name the component; that is not semantic entailment. The reconciliation pass currently uses exact parsed component names and flow endpoints; it
cannot prove discovery of every implicit cross-document relationship. Failed
batches and coverage blocks are visible errors, not an assurance of exhaustive review.

## Keeping documentation current

When changing ingestion, extraction, sampling, prompt budgets, provider limits or
scoring, update this guide and the matching `/docs` sections in the same change.
Update `llm-token-limits.md` for configuration changes and pipeline/current-state
notes for behavioral changes. Keep implemented behavior separate from planned work;
validate the public docs route without triggering model generation. No automatic
documentation synchronization is implemented.

## Hosted model capacities

Exact Kimi API IDs now default to verified capacities: `kimi-k2.6` 262,144 tokens
and `kimi-k3` 1,000,000 tokens (conservative interpretation of 1M).
Sources: [Moonshot model list](https://platform.kimi.com/docs/models),
[official K2.6 model card](https://huggingface.co/moonshotai/Kimi-K2.6).
Explicit `MODEL_CONTEXT_WINDOWS` entries still override these defaults for deployments
with smaller limits. Other unlisted models retain the conservative fallback.
For inputs over 18,000 characters, unknown hosted models now receive
`409 MODEL_CONTEXT_UNVERIFIED` before a run or any analysis model generation is started.
Invalid context configuration returns `400 MODEL_CONTEXT_INVALID`.
After extraction, the exact analyst source plan is checked before fan-out. These
checks cannot guarantee that every future generated review payload will fit.
The capacity catalog version participates in model cache and resume fingerprints.

## Provider billing failures

Provider balance/quota exhaustion is separate from context coverage and temporary
throttling, including providers that return HTTP 429 for both. Billing errors stop
retries and queued model calls within the affected run. In-flight calls may finish.
The failure does not disable unrelated runs. Completed phase outputs are preserved
as partial results when architecture extraction completed; otherwise the run fails
and retains its checkpoints. Unfinished scoring stays unscored, excluded from
severity counts. Database, artifact manifest, and completion webhook all report
partial when the pipeline is incomplete.

Restore provider billing before resuming compatible checkpoints. Do not launch
fresh scans to diagnose this error. The results page recognizes billing failures
in historical local telemetry, even where older public errors incorrectly said
“Request was not authorized.” It does not rewrite historical findings or invent
missing scores.

## Local model readiness

Ollama readiness includes model installation, not only server reachability.
Before creating a run, the analysis API checks the exact selected quick/deep tags
against `/api/tags`. It returns `409 OLLAMA_MODEL_MISSING` with missing and available
models, or `503 OLLAMA_UNAVAILABLE`, without inference. Bare model names match their
`:latest` tags. Known embedding-only models are not offered for generation.
Health reports missing configured models as degraded, and the model picker uses
installed-model presets. Fresh forms use configured server model defaults, while
saved drafts and imported runs keep their explicit selections. Changing model IDs requires a fresh run from saved input
when the previous checkpoints are incompatible; a failed parser has no completed
architecture to reuse. These checks do not guarantee sufficient runtime memory or
context capacity. Source coverage gates still apply.
