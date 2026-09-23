import { describe, it, expect, vi } from 'vitest'
import { pinnedLookup } from '@/lib/webhooks/client'

describe('pinnedLookup', () => {
  it('uses the array callback form when Node requests options.all (Happy Eyeballs, Node 20+)', () => {
    const callback = vi.fn()
    pinnedLookup('93.184.216.34', 4)('example.com', { all: true }, callback)

    expect(callback).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }])
  })

  it('uses the scalar callback form for legacy/explicit-family lookups', () => {
    const callback = vi.fn()
    pinnedLookup('93.184.216.34', 4)('example.com', {}, callback)

    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4)
  })

  it('never triggers a second, unpinned DNS resolution regardless of the hostname passed in', () => {
    const callback = vi.fn()
    // Node always passes the original hostname here — pinnedLookup must ignore it.
    pinnedLookup('203.0.113.9', 6)('attacker-controlled.example', { all: true }, callback)

    expect(callback).toHaveBeenCalledWith(null, [{ address: '203.0.113.9', family: 6 }])
  })
})
