import { describe, expect, it } from 'vitest'
import { readAppendedJsonlLines } from '../jsonl-tail'

describe('readAppendedJsonlLines', () => {
  it('emits complete appended lines once and holds a partial line', () => {
    const first = readAppendedJsonlLines('{"message":"one"}\n{"message":"tw', { offset: 0, tail: '' })
    expect(first.lines).toEqual(['{"message":"one"}'])

    const unchanged = readAppendedJsonlLines('{"message":"one"}\n{"message":"tw', first.cursor)
    expect(unchanged.lines).toEqual([])

    const appended = readAppendedJsonlLines('{"message":"one"}\n{"message":"two"}\n', unchanged.cursor)
    expect(appended.lines).toEqual(['{"message":"two"}'])
    expect(readAppendedJsonlLines('{"message":"one"}\n{"message":"two"}\n', appended.cursor).lines).toEqual([])
  })

  it('starts again when the log is truncated', () => {
    const previous = readAppendedJsonlLines('previous log content\n', { offset: 0, tail: '' })
    expect(readAppendedJsonlLines('new\n', previous.cursor).lines).toEqual(['new'])
  })
})
