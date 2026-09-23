import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
it('loads the SDK transport with its patched Headers dependency on the supported runtime', async () => {
  const require = createRequire(import.meta.url)
  const sdkRequire = createRequire(require.resolve('@cursor/sdk'))
  const connectPath = sdkRequire.resolve('@connectrpc/connect-node')
  const connectRequire = createRequire(connectPath)
  const undici = connectRequire('undici')
  expect(connectRequire('undici/package.json').version).toBe('6.28.0')
  const headers = new undici.Headers([['x-example', 'one'], ['x-example', 'two']])
  expect(headers.get('X-Example')).toBe('one, two')
  const transport = await import(pathToFileURL(connectPath).href)
  expect(typeof transport.createConnectTransport).toBe('function')
  expect(transport.createConnectTransport({ baseUrl: 'http://127.0.0.1:1', httpVersion: '1.1' })).toHaveProperty('unary')
})
