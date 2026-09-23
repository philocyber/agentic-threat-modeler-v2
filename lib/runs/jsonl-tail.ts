export type JsonlTailCursor = { offset: number; tail: string }

/** Return only complete lines appended since the previous read. */
export function readAppendedJsonlLines(text: string, cursor: JsonlTailCursor): {
  lines: string[]
  cursor: JsonlTailCursor
} {
  const reset = text.length < cursor.offset
  const offset = reset ? 0 : cursor.offset
  const newText = (reset ? '' : cursor.tail) + text.slice(offset)
  const lines = newText.split('\n')
  const tail = lines.pop() ?? ''
  return { lines, cursor: { offset: text.length, tail } }
}
