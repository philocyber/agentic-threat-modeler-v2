import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  validateWebhookUrlStructure,
  isBlockedIp,
  resolveSafeWebhookUrl,
  assertSafeWebhookUrl,
} from '@/lib/utils/ssrf'

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }))
vi.mock('dns/promises', () => ({ lookup: lookupMock }))

describe('validateWebhookUrlStructure', () => {
  it('rejects non-https', () => {
    const r = validateWebhookUrlStructure('http://example.com/hook')
    expect(r.ok).toBe(false)
  })

  it('rejects localhost', () => {
    const r = validateWebhookUrlStructure('https://localhost/hook')
    expect(r.ok).toBe(false)
  })

  it('rejects private IPv4 literals', () => {
    expect(validateWebhookUrlStructure('https://127.0.0.1/h').ok).toBe(false)
    expect(validateWebhookUrlStructure('https://10.0.0.5/h').ok).toBe(false)
    expect(validateWebhookUrlStructure('https://192.168.1.1/h').ok).toBe(false)
    expect(validateWebhookUrlStructure('https://169.254.169.254/h').ok).toBe(false)
    expect(validateWebhookUrlStructure('https://172.16.0.1/h').ok).toBe(false)
  })

  it('allows public https hostnames', () => {
    const r = validateWebhookUrlStructure('https://hooks.example.com/tm')
    expect(r.ok).toBe(true)
  })

  it('allows public 172.x outside RFC1918 (e.g. 172.32.x)', () => {
    const r = validateWebhookUrlStructure('https://172.32.0.1/h')
    expect(r.ok).toBe(true)
  })
})

describe('isBlockedIp', () => {
  it('blocks loopback and link-local', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true)
    expect(isBlockedIp('::1')).toBe(true)
    expect(isBlockedIp('169.254.169.254')).toBe(true)
  })

  it('blocks omitted special-use IPv4 ranges', () => {
    expect(isBlockedIp('198.18.0.1')).toBe(true)
    expect(isBlockedIp('192.0.0.1')).toBe(true)
    expect(isBlockedIp('240.0.0.1')).toBe(true)
    expect(validateWebhookUrlStructure('https://198.18.0.1/h').ok).toBe(false)
    expect(validateWebhookUrlStructure('https://192.0.0.1/h').ok).toBe(false)
    expect(validateWebhookUrlStructure('https://240.0.0.1/h').ok).toBe(false)
  })

  it('blocks the full IPv6 link-local range (fe80::/10), not just the fe80 literal', () => {
    expect(isBlockedIp('fe80::1')).toBe(true)
    expect(isBlockedIp('fe90::1')).toBe(true)
    expect(isBlockedIp('fea0::1')).toBe(true)
    expect(isBlockedIp('febf::1')).toBe(true)
    // Deprecated site-local fec0::/10 is also blocked
    expect(isBlockedIp('fec0::1')).toBe(true)
  })

  it('blocks the RFC 6598 CGNAT/shared address space (100.64.0.0/10)', () => {
    expect(isBlockedIp('100.64.0.1')).toBe(true)
    expect(isBlockedIp('100.100.100.100')).toBe(true)
    expect(isBlockedIp('100.127.255.255')).toBe(true)
    // just outside the /10 on either edge must stay unblocked
    expect(isBlockedIp('100.63.255.255')).toBe(false)
    expect(isBlockedIp('100.128.0.0')).toBe(false)
  })

  it('unwraps NAT64-embedded IPv4 addresses (64:ff9b::/96) before checking', () => {
    // 64:ff9b::a9fe:a9fe = 64:ff9b::169.254.169.254 (cloud metadata IP)
    expect(isBlockedIp('64:ff9b::a9fe:a9fe')).toBe(true)
    expect(isBlockedIp('64:ff9b::169.254.169.254')).toBe(true)
    // embedded public IP stays unblocked
    expect(isBlockedIp('64:ff9b::808:808')).toBe(false)
  })

  it('unwraps IPv4-compatible and 6to4 embeddings', () => {
    expect(isBlockedIp('::169.254.169.254')).toBe(true)
    expect(isBlockedIp('::a9fe:a9fe')).toBe(true)
    expect(isBlockedIp('::10.0.0.1')).toBe(true)
    expect(isBlockedIp('2002:a9fe:a9fe::1')).toBe(true)
    expect(isBlockedIp('::ffff:169.254.169.254')).toBe(true)
  })

  it('blocks multicast / broadcast', () => {
    expect(isBlockedIp('255.255.255.255')).toBe(true)
    expect(isBlockedIp('224.0.0.1')).toBe(true)
    expect(isBlockedIp('ff02::1')).toBe(true)
  })
})

describe('validateWebhookUrlStructure credentials', () => {
  it('rejects URLs with userinfo', () => {
    expect(validateWebhookUrlStructure('https://user:pass@hooks.example.com/tm').ok).toBe(false)
  })

  it('rejects IPv4-compatible metadata literals', () => {
    expect(validateWebhookUrlStructure('https://[::169.254.169.254]/x').ok).toBe(false)
    expect(validateWebhookUrlStructure('https://[2002:a9fe:a9fe::1]/x').ok).toBe(false)
  })
})

describe('resolveSafeWebhookUrl', () => {
  beforeEach(() => {
    lookupMock.mockReset()
  })

  it('pins to the resolved address without a second DNS lookup at connect time', async () => {
    lookupMock.mockResolvedValue([{ address: '203.0.113.9', family: 4 }])

    const result = await resolveSafeWebhookUrl('https://hooks.example.com/tm')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.address).toBe('203.0.113.9')
      expect(result.family).toBe(4)
    }
    expect(lookupMock).toHaveBeenCalledTimes(1)
    expect(lookupMock).toHaveBeenCalledWith('hooks.example.com', { all: true, verbatim: true })
  })

  it('rejects a hostname that resolves to a private address (DNS rebinding defense)', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }])

    const result = await resolveSafeWebhookUrl('https://attacker-controlled.example/tm')

    expect(result.ok).toBe(false)
  })

  it('rejects when any resolved address (of several) is private, not just the first', async () => {
    lookupMock.mockResolvedValue([
      { address: '203.0.113.9', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ])

    const result = await resolveSafeWebhookUrl('https://multi-homed.example/tm')

    expect(result.ok).toBe(false)
  })

  it('rejects when DNS resolution fails outright', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'))

    const result = await resolveSafeWebhookUrl('https://does-not-exist.example/tm')

    expect(result.ok).toBe(false)
  })

  it('skips DNS resolution entirely for literal-IP targets', async () => {
    const result = await resolveSafeWebhookUrl('https://203.0.113.9/tm')

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.address).toBe('203.0.113.9')
    expect(lookupMock).not.toHaveBeenCalled()
  })
})

describe('assertSafeWebhookUrl', () => {
  beforeEach(() => {
    lookupMock.mockReset()
  })

  it('resolves ok for a hostname that only maps to public addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '203.0.113.9', family: 4 }])
    const result = await assertSafeWebhookUrl('https://hooks.example.com/tm')
    expect(result.ok).toBe(true)
  })

  it('rejects a hostname that maps to a private address', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    const result = await assertSafeWebhookUrl('https://hooks.example.com/tm')
    expect(result.ok).toBe(false)
  })
})
