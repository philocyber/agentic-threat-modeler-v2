import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { isTrustedLocalMutation } from '../local-mutation'

describe('local mutation boundary', () => {
  it.each(['localhost:3000', '127.0.0.1:3000', '[::1]:3000', '127.0.2.2:3000'])(
    'accepts browser requests to %s despite NextURL loopback normalization', (host) => {
      const origin = `http://${host}`
      const request = new NextRequest(`${origin}/api/v1/results/run-one`, {
        method: 'DELETE',
        headers: { host, origin, 'sec-fetch-site': 'same-origin' },
      })
      expect(request.nextUrl.hostname).toBe('localhost')
      expect(isTrustedLocalMutation(request)).toBe(true)
    },
  )

  it.each([
    ['127.0.0.1:3000', 'http://localhost:3000'],
    ['localhost:3000', 'http://127.0.0.1:3000'],
    ['127.0.0.1:3000', 'http://127.0.0.1:3001'],
    ['localhost:3000', 'https://localhost:3000'],
    ['attacker.example:3000', 'http://attacker.example:3000'],
    ['192.168.1.10:3000', 'http://192.168.1.10:3000'],
    ['localhost.attacker.example:3000', 'http://localhost.attacker.example:3000'],
    ['localhost:3000', 'null'],
    ['localhost:3000', 'not-a-url'],
    ['localhost:3000', 'http://localhost:3000/path'],
    ['localhost:3000', 'http://user@localhost:3000'],
    ['localhost:3000@attacker.example', 'http://localhost:3000'],
    ['localhost:3000/path', 'http://localhost:3000'],
    ['localhost:3000, attacker.example', 'http://localhost:3000'],
  ])('rejects Host %s with Origin %s even when Next uses a local server URL', (host, origin) => {
    const request = new NextRequest('http://localhost:3000/api/v1/results/run-one', {
      method: 'DELETE',
      headers: { host, origin, 'sec-fetch-site': 'same-origin' },
    })
    expect(isTrustedLocalMutation(request)).toBe(false)
  })

  it('does not use forwarded host to authorize another browser origin', () => {
    const request = new NextRequest('http://localhost:3000/api/v1/results/run-one', {
      method: 'DELETE',
      headers: { host: 'attacker.example', origin: 'http://localhost:3000', 'x-forwarded-host': 'localhost:3000' },
    })
    expect(isTrustedLocalMutation(request)).toBe(false)
  })

  it('preserves direct local CLI requests without an Origin', () => {
    const request = new NextRequest('http://localhost:3000/api/v1/results/run-one', {
      method: 'DELETE', headers: { host: '127.0.0.1:3000' },
    })
    expect(isTrustedLocalMutation(request)).toBe(true)
  })

  it('accepts a same-origin localhost request', () => {
    const request = new NextRequest('http://localhost:3001/api/v1/knowledge', {
      method: 'POST',
      headers: { origin: 'http://localhost:3001', 'sec-fetch-site': 'same-origin' },
    })
    expect(isTrustedLocalMutation(request)).toBe(true)
  })

  it('rejects cross-site and non-loopback mutations', () => {
    const crossSite = new NextRequest('http://localhost:3001/api/v1/index', {
      method: 'POST',
      headers: { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
    })
    const remoteHost = new NextRequest('http://192.168.1.10:3001/api/v1/index', { method: 'POST' })
    expect(isTrustedLocalMutation(crossSite)).toBe(false)
    expect(isTrustedLocalMutation(remoteHost)).toBe(false)
  })
})
