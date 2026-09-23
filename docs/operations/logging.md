# Logging y auditoría

Argus distingue logs operacionales de eventos de auditoría.

## Log operacional

`logger.info`, `warn`, `error` y `debug` emiten JSON por stdout/stderr:

```ts
import { logger } from '@/lib/logger'

logger.info('Analysis started', {
  analysisId,
  provider,
  phase: 'architecture_parser',
})
```

Salida aproximada:

```json
{"timestamp":"<ISO-8601 timestamp>","level":"info","message":"Analysis started","analysisId":"tm_123","provider":"bedrock","phase":"architecture_parser"}
```

`debug` sólo emite en `NODE_ENV=development`. Todavía existen `console.*`
directos en algunos módulos, por lo que el sink debe tolerar líneas no JSON.

## Contexto por request

El logger usa `AsyncLocalStorage`; requests concurrentes no deberían compartir
`requestId`, IP o metadata.

Patrón actual:

```ts
logger.setContext({
  requestId: request.headers.get('x-request-id') ?? crypto.randomUUID(),
  ...logger.extractRequestMetadata(request),
})

try {
  // request
} finally {
  logger.clearContext()
}
```

`extractRequestMetadata` conserva `X-Forwarded-For`, `X-Real-IP`,
`CF-Connecting-IP`, `True-Client-IP`, `X-Client-IP` y `Forwarded` en
`ipHeaders`. `ipAddress` y el rate limiter comparten la misma política:
`X-Forwarded-For` sólo se usa cuando `TRUSTED_PROXY_HOPS > 0`; los headers
alternativos nunca se consideran una identidad de red confiable.

## Evento de auditoría

Para persistir además en `audit_logs`:

```ts
logger.info(
  'Analysis requested',
  { analysisId },
  {
    audit: {
      eventType: 'analysis_requested',
      metadata: { source: 'api' },
    },
  },
)
```

La escritura de auditoría es best-effort. Si falla, se emite
`[AUDIT_LOG_FAILED]`; la operación principal continúa. Por eso la tabla no es un
ledger WORM ni una garantía transaccional.

## Eventos persistibles

La única lista compartida vive en `lib/db/enums.ts`:

```text
analysis_requested
analysis_completed
analysis_failed
analysis_archived
analysis_restored
analysis_deleted
threat_justified
threat_dismissed
threat_confirmed
threat_comment_added
threat_review_updated
rag_index_updated
reviewer_learning_applied
```

Logs como `pre_dedup` y `pipeline_graph_compiled` son telemetría operacional en
metadata/stdout y no deben agregarse al enum PostgreSQL.

## Storage

En SQLite:

```sql
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
```

En PostgreSQL, `event_type` usa el enum `audit_event_type`, `metadata` es JSONB,
`ip_address` es `inet` y `created_at` es timestamp. Hay índices por tipo y fecha.

La tabla es la del backend activo:

- workspace local -> SQLite del proyecto;
- `DATABASE_URL` -> PostgreSQL/RDS.

## Queries operativas PostgreSQL

Fallos recientes:

```sql
SELECT event_type, count(*) AS events, max(created_at) AS latest
FROM audit_logs
WHERE event_type = 'analysis_failed'
  AND created_at >= now() - interval '24 hours'
GROUP BY event_type;
```

Actividad por principal cuando está presente en metadata:

```sql
SELECT metadata->>'createdBy' AS principal, count(*)
FROM audit_logs
WHERE created_at >= now() - interval '30 days'
GROUP BY metadata->>'createdBy';
```

No todos los eventos incorporan `createdBy`; la query no debe interpretarse como
un reporte completo de identidad.

## Redacción y minimización

Nunca incluir en `meta`, contexto ni audit metadata:

- bearer tokens;
- passwords o URLs con userinfo;
- API keys;
- raw input completo;
- prompts/respuestas LLM completos;
- contenido completo de uploads;
- excerpts sensibles de knowledge base.

Sí incluir, cuando corresponda:

- IDs opacos (`analysisId`, `systemId`, `uploadId`);
- provider y nombre de modelo no secreto;
- fase y clasificación de error;
- duración, tokens y conteos;
- request ID y actor ID ya derivado;
- host de webhook, nunca query string sensible.

## Retención y exportación

El repositorio no impone una retención. En AWS:

- stdout/stderr debe enviarse a CloudWatch Logs o sink aprobado;
- definir retention y cifrado del log group;
- restringir consultas de auditoría a roles autorizados;
- exportar al SIEM sólo los campos necesarios;
- alarmar por fallos, rate limits, auth failures y runs huérfanos;
- evitar logging SQL con valores sensibles.

Si se requiere evidencia inmutable, replicar eventos a un storage WORM/ledger
externo; `audit_logs` por sí sola permite UPDATE/DELETE al rol que tenga esos
privilegios.

## Limitaciones conocidas

- No todos los módulos usan todavía el logger unificado.
- La auditoría no es transaccional con la acción de negocio.
- No hay log drain, SIEM ni alertas configurados por el repositorio.
- No hay trace ID distribuido real; `withTelemetrySpan` es no-op.
- La confianza en headers IP del logger y la del rate limiter no están
  completamente unificadas.
- Telemetría JSONL de run existe sólo para workspaces locales.
