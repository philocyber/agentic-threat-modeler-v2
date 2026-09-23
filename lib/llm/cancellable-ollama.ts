import { AsyncLocalStorage } from 'node:async_hooks'
import { ChatOllama } from '@langchain/ollama'
import { withOllamaInferenceStream } from './ollama-queue'

async function* withinRequest<T>(
  scope: AsyncLocalStorage<AbortSignal | undefined>,
  signal: AbortSignal | undefined,
  stream: AsyncGenerator<T>,
): AsyncGenerator<T> {
  signal?.throwIfAborted()
  try {
    while (true) {
      const next = await scope.run(signal, () => stream.next())
      if (next.done) return
      yield next.value
    }
  } finally {
    await scope.run(signal, () => stream.return(undefined))
  }
}

/** Cancel the request while queued or reading, without aborting sibling calls. */
export class CancellableChatOllama extends ChatOllama {
  private readonly requestScope: AsyncLocalStorage<AbortSignal | undefined>
  private readonly endpoint: string
  lastInferenceWaitMs = 0

  constructor(fields: ConstructorParameters<typeof ChatOllama>[0]) {
    const scope = new AsyncLocalStorage<AbortSignal | undefined>()
    const transport = fields?.fetch ?? globalThis.fetch
    super({
      ...fields,
      fetch: (input, init) => {
        const signal = scope.getStore()
        if (!signal) return transport(input, init)
        const signals = [signal, init?.signal, input instanceof Request ? input.signal : undefined]
          .filter((item): item is AbortSignal => Boolean(item))
        return transport(input, { ...init, signal: AbortSignal.any(signals) })
      },
    })
    this.requestScope = scope
    this.endpoint = fields?.baseUrl ?? 'http://127.0.0.1:11434'
  }

  override async *_streamResponseChunks(...args: Parameters<ChatOllama['_streamResponseChunks']>) {
    const [messages, options, manager] = args
    const forwarded = { ...options }
    delete forwarded.signal
    const queuedAt = Date.now()
    yield* withOllamaInferenceStream(this.endpoint, options.signal, () => {
      this.lastInferenceWaitMs = Date.now() - queuedAt
      return withinRequest(this.requestScope, options.signal,
        super._streamResponseChunks(messages, forwarded as this['ParsedCallOptions'], manager))
    })
  }

  override async *_streamChatModelEvents(...args: Parameters<ChatOllama['_streamChatModelEvents']>) {
    const [messages, options, manager] = args
    const forwarded = { ...options }
    delete forwarded.signal
    const queuedAt = Date.now()
    yield* withOllamaInferenceStream(this.endpoint, options.signal, () => {
      this.lastInferenceWaitMs = Date.now() - queuedAt
      return withinRequest(this.requestScope, options.signal,
        super._streamChatModelEvents(messages, forwarded as this['ParsedCallOptions'], manager))
    })
  }
}
