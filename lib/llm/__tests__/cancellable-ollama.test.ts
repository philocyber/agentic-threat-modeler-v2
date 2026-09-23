import { createServer } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { HumanMessage } from '@langchain/core/messages'
import { CancellableChatOllama } from '../cancellable-ollama'

describe('Ollama request cancellation', () => {
  it.each(['headers', 'body'].flatMap(waitingFor => ['invoke', 'stream', 'events'].map(mode => ({ waitingFor, mode }))))(
    'cancels $mode waiting for $waitingFor without cancelling a sibling', async ({ waitingFor, mode }) => {
    const started = Promise.withResolvers<void>()
    const closed = Promise.withResolvers<void>()
    const siblingStarted = Promise.withResolvers<void>()
    const releaseSibling = Promise.withResolvers<void>()
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      const request = JSON.parse(body)
      if (request.messages[0].content === 'blocked') {
        res.once('close', () => closed.resolve())
        if (waitingFor === 'body') {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
          res.flushHeaders()
        }
        started.resolve()
        return
      }
      siblingStarted.resolve()
      await releaseSibling.promise
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      res.end(JSON.stringify({ model: 'test', message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' }) + '\n')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')
    const model = new CancellableChatOllama({ model: 'test', baseUrl: `http://127.0.0.1:${address.port}` })
    const invoke = async (input: string, signal?: AbortSignal): Promise<string> => {
      const options = signal ? { signal } : {}
      if (mode === 'invoke') return String((await model.invoke(input, options)).content)
      const stream = mode === 'events'
        ? model._streamChatModelEvents([new HumanMessage(input)], options)
        : await model.stream(input, options)
      let output = ''
      for await (const chunk of stream) output += JSON.stringify(chunk)
      return output
    }
    const controller = new AbortController()
    try {
      const blocked = invoke('blocked', controller.signal)
      const rejected = expect(blocked).rejects.toThrow()
      await started.promise
      const sibling = invoke('sibling')
      controller.abort()
      await rejected
      // This proves the HTTP connection closes before any response token is
      // available, rather than only rejecting the application's outer promise.
      await closed.promise
      await siblingStarted.promise
      releaseSibling.resolve()
      expect(await sibling).toContain(mode === 'invoke' ? 'ok' : '"ok"')
    } finally {
      controller.abort()
      releaseSibling.resolve()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 5_000)
})
