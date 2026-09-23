/** Reuse only chunks whose exact text and all embedding-context metadata match. */
export function canReuseIndexedChunk(
  existing: { document: string | null; metadata: Record<string, unknown> | null } | undefined,
  document: string,
  metadata: Record<string, unknown>,
): boolean {
  if (!existing || existing.document !== document || !existing.metadata) return false
  const keys = Object.keys(metadata)
  return Object.keys(existing.metadata).length === keys.length
    && keys.every((key) => existing.metadata![key] === metadata[key])
}
