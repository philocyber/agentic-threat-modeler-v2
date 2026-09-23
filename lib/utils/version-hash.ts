import crypto from 'crypto'

export type HashableInput = {
  systemName: string
  input: string
  supportingDocuments?: Array<{
    name: string
    content: string
  }> | undefined
}

/**
 * Calcula un hash SHA-256 del payload de análisis normalizado
 * para detectar cambios en el RFC fuente.
 * 
 * @param data - Datos del análisis (systemName, input, supportingDocuments)
 * @returns Hash SHA-256 en formato hexadecimal
 * 
 * @example
 * ```ts
 * const hash = calculateVersionHash({
 *   systemName: 'Sistema de Pagos QR',
 *   input: '# RFC\n\nSistema de pagos...',
 *   supportingDocuments: [
 *     { name: 'diagram.png', content: 'base64...' }
 *   ]
 * })
 * // => 'a3b2c1d4e5f6...'
 * ```
 */
export function calculateVersionHash(data: HashableInput): string {
  // 1. Normalizar campos
  const normalized = {
    systemName: data.systemName.trim(),
    input: data.input.trim(),
    supportingDocuments: data.supportingDocuments
      ? data.supportingDocuments
          .map((doc) => ({
            name: doc.name.trim(),
            content: doc.content.trim(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)) // Ordenar alfabéticamente
      : [],
  }

  // 2. Convertir a JSON canónico
  const canonical = JSON.stringify(normalized, null, 0)

  // 3. Calcular SHA-256
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')
}
