/** Format common plain-text exports for reading without changing the saved input. */
export function formatAnalysisRequest(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const numberedHeading = /^\d+(?:\.\d+)*\.?\s+[A-Z][^\n]{0,88}$/
  const documentLike = !lines.some((line) => /^#{1,3}\s/.test(line))
    && lines.filter((line) => numberedHeading.test(line)).length >= 2
  const firstText = lines.findIndex((line) => line.trim().length > 0)
  const output: string[] = []
  let fenced = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      output.push(line)
      continue
    }
    if (fenced) { output.push(line); continue }

    if (line.trim() === 'text' && /^\+[-+]{6,}/.test((lines[index + 1] ?? '').trim())) {
      const diagram: string[] = []
      let cursor = index + 1
      while (cursor < lines.length && !numberedHeading.test(lines[cursor] ?? '') && (lines[cursor] ?? '').trim()) {
        diagram.push(lines[cursor] ?? '')
        cursor += 1
      }
      if (diagram.length >= 3) {
        output.push('', '```text', ...diagram, '```', '')
        index = cursor - 1
        continue
      }
    }

    if (line.includes('\t') && (lines[index + 1] ?? '').includes('\t')) {
      const rows: string[][] = []
      let cursor = index
      while (cursor < lines.length && (lines[cursor] ?? '').includes('\t')) {
        rows.push((lines[cursor] ?? '').split('\t').map((cell) => cell.trim()))
        cursor += 1
      }
      const columns = rows[0]?.length ?? 0
      if (rows.length >= 2 && columns >= 2 && columns <= 10 && rows.every((row) => row.length === columns)) {
        const row = (cells: string[]) => `| ${cells.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`
        output.push('', row(rows[0] ?? []), row(Array(columns).fill('---') as string[]), ...rows.slice(1).map(row), '')
        index = cursor - 1
        continue
      }
    }

    if (documentLike && index === firstText && lines.slice(index + 1, index + 5).some((next) => /^[A-Za-z][^:]{2,28}:\s/.test(next))) {
      output.push(`# ${line}`, '')
      continue
    }
    if (documentLike && numberedHeading.test(line)) {
      const depth = /^\d+\./.test(line) && !/^\d+\.\s/.test(line) ? 3 : 2
      output.push('', `${'#'.repeat(depth)} ${line}`, '')
      continue
    }
    if (documentLike && index < firstText + 7 && /^[A-Za-z][^:]{2,28}:\s/.test(line)) {
      const colon = line.indexOf(':')
      output.push(`**${line.slice(0, colon)}:**${line.slice(colon + 1)}  `)
      continue
    }
    output.push(line)
  }

  return output.join('\n')
}
