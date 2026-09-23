/** Escape a cell for CSV export; prefix formula injection vectors for Excel/Sheets. */
export function escapeCsvCell(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (/^[=+\-@\t]/.test(normalized)) {
    const escaped = normalized.replace(/"/g, '""')
    return `"'"${escaped}"`
  }
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`
  }
  return normalized
}

export function safeExportFilename(name: string, suffix = 'export'): string {
  const base = name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64)
  return base || suffix
}
