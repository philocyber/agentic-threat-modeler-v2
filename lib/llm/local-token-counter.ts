import { Tokenizer } from '@huggingface/tokenizers'

export type TokenCountedModel = {
  contextWindow?: number
  outputTokenReserve?: number
  countTextTokens?: (text: string) => number
}

// Qwen2/Qwen3 GGUF pre-tokenization, verified against Qwen's tokenizer.json.
const QWEN_PATTERN = "(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+"

// GGUF qwen35 uses combining marks in letter runs. Match llama.cpp BPE,
// which does not apply the NFC normalizer from the Hugging Face tokenizer.
// https://github.com/ggml-org/llama.cpp/blob/master/src/llama-vocab.cpp
const QWEN35_PATTERN = "(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?[\\p{L}\\p{M}]+|\\p{N}| ?[^\\s\\p{L}\\p{M}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+"

export function createLocalTokenCounter(info: Record<string, unknown>): ((text: string) => number) | null {
  if (info['tokenizer.ggml.model'] !== 'gpt2' || !['qwen2', 'qwen35'].includes(String(info['tokenizer.ggml.pre']))) return null
  const tokens = info['tokenizer.ggml.tokens']
  const merges = info['tokenizer.ggml.merges']
  const types = info['tokenizer.ggml.token_type']
  if (!Array.isArray(tokens) || !tokens.length || !tokens.every(token => typeof token === 'string')
    || !Array.isArray(merges) || !merges.every(merge => typeof merge === 'string')
    || !Array.isArray(types) || types.length !== tokens.length) return null
  const tokenizer = new Tokenizer({
    version: '1.0', normalizer: null, post_processor: null,
    added_tokens: tokens.flatMap((content, id) => types[id] === 3 ? [{
      id, content, special: true, single_word: false, lstrip: false, rstrip: false, normalized: false,
    }] : []),
    pre_tokenizer: { type: 'Sequence', pretokenizers: [
      { type: 'Split', pattern: { Regex: info['tokenizer.ggml.pre'] === 'qwen35' ? QWEN35_PATTERN : QWEN_PATTERN }, behavior: 'Isolated', invert: false },
      { type: 'ByteLevel', add_prefix_space: false, trim_offsets: false, use_regex: false },
    ] },
    model: { type: 'BPE', vocab: Object.fromEntries(tokens.map((token, id) => [token, id])), merges, byte_fallback: false },
    decoder: { type: 'ByteLevel', add_prefix_space: false, trim_offsets: false, use_regex: false },
  }, { tokenizer_class: 'Qwen2Tokenizer' })
  return text => tokenizer.encode(text).ids.length
}

const loading = new Map<string, { until: number; promise: Promise<((text: string) => number) | null> }>()

/** Vocabulary stays on the configured Ollama service; no source text is sent out. */
export async function prepareLocalTokenCounters(models: unknown[], baseUrl: string): Promise<void> {
  await Promise.all(models.map(async (value) => {
    const model = value as TokenCountedModel & { providerName?: string; model?: string }
    if (model.providerName !== 'ollama' || typeof model.model !== 'string') return
    const key = `${baseUrl}:${model.model}`
    let entry = loading.get(key)
    if (!entry || entry.until < Date.now()) {
      const promise = (async () => {
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/show`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: model.model, verbose: true }), signal: AbortSignal.timeout(15_000),
        })
        if (!response.ok) return null
        const body = await response.json() as { model_info?: Record<string, unknown> }
        return body.model_info ? createLocalTokenCounter(body.model_info) : null
      })().catch(() => null)
      entry = { until: Date.now() + 60_000, promise }
      loading.set(key, entry)
    }
    const count = await entry.promise
    if (count) model.countTextTokens = count
    else delete model.countTextTokens
  }))
}
