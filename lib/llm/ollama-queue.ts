type Slot = {
  waitMs: number
}

const tails = new Map<string, Promise<void>>()

function endpointKey(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    return `${url.protocol}//${url.host}`
  } catch {
    return baseUrl
  }
}

async function acquireSlot(baseUrl: string, signal?: AbortSignal): Promise<{ waitMs: number; release: () => void }> {
  signal?.throwIfAborted()
  const key = endpointKey(baseUrl)
  const previous = tails.get(key) ?? Promise.resolve()
  let release: () => void = () => {}
  const current = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.then(() => current, () => current)
  tails.set(key, tail)
  void tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
  const queuedAt = Date.now()
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal!.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
      previous.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort))
      if (signal?.aborted) onAbort()
    })
    signal?.throwIfAborted()
  } catch (error) {
    // Resolve our slot, but keep it chained behind the active predecessor.
    // Cancellation must not let a later request overlap that predecessor.
    release()
    throw error
  }
  return { waitMs: Date.now() - queuedAt, release }
}

/** One active generative call per Ollama endpoint. Embeddings use a separate client. */
export async function withOllamaInferenceSlot<T>(
  baseUrl: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<{ value: T } & Slot> {
  const slot = await acquireSlot(baseUrl, signal)
  try {
    return { value: await run(), waitMs: slot.waitMs }
  } finally {
    slot.release()
  }
}

/** Hold the endpoint slot until the async generator completes. */
export async function* withOllamaInferenceStream<T>(
  baseUrl: string,
  signal: AbortSignal | undefined,
  create: () => AsyncGenerator<T>,
): AsyncGenerator<T> {
  const slot = await acquireSlot(baseUrl, signal)
  try {
    yield* create()
  } finally {
    slot.release()
  }
}

export function ollamaTimingsFromMetadata(metadata: Record<string, unknown> | undefined): {
  loadMs: number | null
  processingMs: number | null
  generationMs: number | null
} {
  const ns = (key: string): number | null => {
    const value = metadata?.[key]
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(value / 1e6) : null
  }
  return {
    loadMs: ns('load_duration'),
    processingMs: ns('prompt_eval_duration'),
    generationMs: ns('eval_duration'),
  }
}
