import { describe, expect, it } from 'vitest'
import { mergeProgressEvents, parseProgressEvents } from '../progress-events'
describe('durable progress replay', () => {
  it('preserves counts and real timestamps after reconnect', () => {
    const disk = parseProgressEvents('{"phase":"stride_analyst","status":"done","timestamp":100,"count":8}\n{"phase":"pre_dedup","status":"done","timestamp":200,"count":10}\ntruncated')
    expect(mergeProgressEvents(disk, [{ phase: 'stride_analyst', status: 'done', timestamp: 100 }])).toEqual(disk)
  })
  it('rejects corrupt event shapes', () => {
    expect(parseProgressEvents('{}\n{"phase":"x","status":"done","timestamp":"bad"}')).toEqual([])
  })
})
