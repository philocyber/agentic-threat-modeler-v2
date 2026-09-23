# LLM Output Token Limits Configuration

How to configure maximum **output** tokens per provider / tier. Defaults live in `lib/config/index.ts`.

For input windows, document sampling and downstream evidence budgets, see
[Context and coverage](context-and-coverage.md). Output caps do not control how
much source material survives the pipeline.

## Overview

- Too low → truncated JSON / failed Zod parse
- Too high → longer generations and higher cost on cloud providers
- Limits must fit the model’s max output capability

## Tiers (roles)

The factory selects the deep cap for `deep` and `stride` roles and the quick
cap for other roles. Model routing profiles can change which model serves a
phase; a larger selected model does not automatically enlarge evidence budgets.
Typical roles (consult the execution snapshot for the actual run):

| Tier env | Typical use |
|----------|-------------|
| `*_QUICK_MAX_TOKENS` | Architecture parse (when applicable), PASTA, attack trees, DREAD |
| `*_DEEP_MAX_TOKENS` | STRIDE, debate, synthesis (`deep` / `stride` roles) |

## Defaults

### Ollama

```bash
OLLAMA_QUICK_MAX_TOKENS="4096"
OLLAMA_DEEP_MAX_TOKENS="8192"
```

Models default to `qwen3.5:4b` (quick) / `qwen3.5:9b` (deep) unless overridden.

### Gemini

```bash
GEMINI_QUICK_MAX_TOKENS="8192"
GEMINI_DEEP_MAX_TOKENS="16384"
```

### Kimi / Moonshot

```bash
KIMI_QUICK_MAX_TOKENS="8192"
KIMI_DEEP_MAX_TOKENS="16384"
```

### AWS Bedrock

```bash
BEDROCK_QUICK_MAX_TOKENS="8192"
BEDROCK_DEEP_MAX_TOKENS="16384"
```

### Cursor

El adapter Cursor actual no expone variables `CURSOR_*_MAX_TOKENS`. Usa el
contrato de `Agent.prompt` y sus límites dependen del runtime/modelo de Cursor.

## Small local models

If using very small Ollama models, consider lowering limits and `PIPELINE_TARGET_THREATS`:

```bash
OLLAMA_QUICK_MAX_TOKENS="2048"
OLLAMA_DEEP_MAX_TOKENS="4096"
PIPELINE_TARGET_THREATS="10"
```

## Troubleshooting

### Truncated JSON / parse errors

First check whether generation reached its output cap, the schema failed for another
reason, or input context overflowed. Increase the relevant `*_MAX_TOKENS` only for
confirmed output truncation, within the selected model capability and available
context. Restart the app after changing environment settings. A higher output cap
does not itself change model context capacity; source-backed runs now plan
complete source groups and notes against the configured context. Avoid a paid rerun until the failing stage is understood.

### Slow runs / OOM on Ollama

Configure `OLLAMA_QUICK_NUM_CTX` (default 16384) and `OLLAMA_DEEP_NUM_CTX`
(default 32768), alongside output caps, to fit available memory. Lowering context
can reduce evidence retention. The local guard uses an approximate four-character
per token estimate; it rejects overflow when original SRC passages or stable RAG citations are
present. Legacy unreferenced Ollama messages can still be compacted. See the coverage guide before tuning.

### Env priority

1. Explicit `PROVIDER_QUICK_MAX_TOKENS` / `PROVIDER_DEEP_MAX_TOKENS`
2. Schema defaults in `lib/config/index.ts`

No override needed if defaults work.

## Cost note (cloud)

Higher caps do not bill by themselves; cost grows when the model actually emits more tokens. Prefer defaults until you see truncation.

## Hosted input capacity (separate from output caps)

Kimi K2.6 and K3 use verified defaults (262,144 and 1,000,000 tokens).
Set `MODEL_CONTEXT_WINDOWS` to override a deployment capacity or map another exact model
ID to its verified context capacity in tokens. For example, using a placeholder:

```bash
MODEL_CONTEXT_WINDOWS='{"your-exact-model-id":131072}'
```

Unlisted hosted models use a conservative 32768-token planning window, not an
assertion of their maximum capacity. Restart after configuration changes. The
selected tier output cap is reserved before source packets are planned. These
settings are included in the resume fingerprint. Changing model name requires a
separate capacity entry; overrides are not copied automatically between models.

## Live-run correction: verified Kimi capacities

A regression run, `tm_73c030e8-487e-4f1d-825c-919f245f9c09`,
finished extraction but stopped before analyst inference because the 32K fallback,
with a 16K output reserve, left only 18,083 source characters for reconciliation.
This was an application capacity-configuration failure, not a provider rejection.

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
