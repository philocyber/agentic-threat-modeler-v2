/**
 * Reserved seam for a future observability integration.
 *
 * The local product currently persists run state, errors and RAG traces in its
 * own storage. It has no configured OTLP collector, so this no-op wrapper keeps
 * application code independent from a future metrics provider without loading
 * OpenTelemetry or native transport dependencies during development.
 */
export async function withTelemetrySpan<T>(
  _name: string,
  _attributes: Record<string, string | number | boolean | undefined>,
  callback: () => Promise<T>,
): Promise<T> {
  return callback()
}
