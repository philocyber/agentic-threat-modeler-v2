import { AsyncLocalStorage } from 'node:async_hooks'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'

/** The installed adapter drops call options between _generate and completionWithRetry. */
export class CancellableChatGoogleGenerativeAI extends ChatGoogleGenerativeAI {
  private readonly requestScope = new AsyncLocalStorage<AbortSignal | undefined>()

  override _generate(...args: Parameters<ChatGoogleGenerativeAI['_generate']>) {
    return this.requestScope.run(args[1].signal, () => super._generate(...args))
  }

  override completionWithRetry(...args: Parameters<ChatGoogleGenerativeAI['completionWithRetry']>) {
    const signal = this.requestScope.getStore()
    if (!signal) return super.completionWithRetry(...args)
    const [request, options] = args
    return super.completionWithRetry(request, {
      ...options,
      signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
    })
  }
}
