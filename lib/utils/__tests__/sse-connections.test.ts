import { afterEach, describe, expect, it } from 'vitest'
import { _clearSseConnections, reserveSseConnection } from '../sse-connections'

afterEach(_clearSseConnections)

describe('SSE connection reservations', () => {
  it('limits each actor/run pair and guarantees idempotent cleanup', () => {
    const reservations = Array.from({ length: 5 }, () => reserveSseConnection('alice', 'run-1'))
    expect(reservations.every((reservation) => reservation.allowed)).toBe(true)
    expect(reserveSseConnection('alice', 'run-1')).toEqual({ allowed: false })
    expect(reserveSseConnection('bob', 'run-1').allowed).toBe(true)
    const first = reservations[0]
    if (first?.allowed) {
      first.release()
      first.release()
    }
    expect(reserveSseConnection('alice', 'run-1').allowed).toBe(true)
  })
})
