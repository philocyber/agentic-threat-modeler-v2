type IndexGenerationGlobal = typeof globalThis & {
  __agenticTmRagIndexGeneration?: number
  __agenticTmRagInvalidators?: Map<string, () => void>
}

const globalState = globalThis as IndexGenerationGlobal

export function registerRAGIndexInvalidator(name: string, invalidator: () => void): void {
  globalState.__agenticTmRagInvalidators ??= new Map()
  globalState.__agenticTmRagInvalidators.set(name, invalidator)
}

export function bumpRAGIndexGeneration(): number {
  globalState.__agenticTmRagIndexGeneration = (globalState.__agenticTmRagIndexGeneration ?? 0) + 1
  for (const invalidator of globalState.__agenticTmRagInvalidators?.values() ?? []) invalidator()
  return globalState.__agenticTmRagIndexGeneration
}
