# Observabilidad de Argus

Este documento separa señales implementadas de integraciones recomendadas. La
aplicación no incluye hoy un backend APM ni un exportador OTLP operativo.

## Señales implementadas

### Logs operacionales

`lib/logger/` emite una línea JSON por stdout con timestamp, nivel, mensaje,
contexto y metadata. `debug` sólo se emite en desarrollo. El contexto usa
`AsyncLocalStorage` para evitar cruces entre requests concurrentes.

Todavía existen algunos `console.*` directos fuera del logger, especialmente en
pipeline, RAG y recovery. El agregador debe aceptar ambos formatos mientras se
completa la unificación.

### Auditoría

Un log puede persistir además un evento en `audit_logs`. La persistencia es
best-effort: una falla de auditoría se reporta por stderr pero no revierte la
operación principal.

Eventos persistibles actuales:

- `analysis_requested`, `analysis_completed`, `analysis_failed`.
- `analysis_archived`, `analysis_restored`, `analysis_deleted`.
- `threat_justified`, `threat_dismissed`, `threat_confirmed`.
- `threat_comment_added`, `threat_review_updated`.
- `rag_index_updated`, `reviewer_learning_applied`.

`pre_dedup` y `pipeline_graph_compiled` son telemetría operacional, no eventos
del enum de auditoría.

### Estado y health

- `GET /api/health`: liveness público. En PostgreSQL ejecuta `SELECT 1`; en
  local informa `mode: local` sin intentar conectar a Postgres.
- `GET /api/v1/health`: deep health protegido en modo servicio. Comprueba base,
  provider configurado, readiness RAG y liveness de `pipeline-worker`.
- `GET /api/v1/analysis/:id/status`: estado persistido de una corrida.
- `GET /api/v1/analysis/:id/telemetry`: fases y logs disponibles para la UI.
- SSE transmite progreso en vivo y hace polling de base cada cinco segundos como
  failsafe del estado terminal.

La página de análisis en vivo muestra la telemetría abierta debajo del mapa:
fases, avisos y eventos operacionales se actualizan cada cinco segundos. Desde
allí se puede descargar el JSONL completo. Al terminar, la misma telemetría
permanece en **Run details**. Estos eventos operacionales no reemplazan los
registros de auditoría de decisiones del revisor.

### Telemetría local de runs

En workspaces SQLite se escriben:

```text
runs/<id>/progress.jsonl
runs/<id>/telemetry.jsonl
runs/<id>/rag-trace.json
runs/<id>/quality.json
```

El worker agrega eventos a los dos JSONL. Las APIs de estado, telemetría y SSE
leen esos archivos directamente dentro del proyecto activo, también después de
recargar la UI. Son registros mutables y no requieren una fila en el catálogo de
checkpoints. Los checkpoints y resultados sí conservan verificación SHA-256.

En modo PostgreSQL/RDS, los artefactos y JSONL se guardan en `run_artifacts`;
los procesos de UI y worker comparten su lectura a través de la base. El estado,
usage agregado, `pipeline_errors` y auditoría también quedan en la base.

### Usage LLM

El pipeline agrega:

- input/output tokens y llamadas;
- usage por modelo;
- provider/model/agent;
- eventos de best-effort parsing y retries;
- coste estimado cuando `LLM_PRICES_JSON` contiene el modelo.

Los precios nunca se adivinan. Un modelo sin tarifa conserva tokens pero queda
sin coste calculado.

## Lo que no está implementado

`withTelemetrySpan` en `lib/observability/telemetry.ts` es un wrapper no-op. Por
lo tanto, hoy no existen en el producto:

- exportador OpenTelemetry/OTLP;
- spans distribuidos reales;
- métricas Prometheus;
- dashboard Grafana incluido;
- integración Sentry;
- alertas o paging;
- correlación frontend/backend mediante `traceparent`.

No configurar `OTEL_*` esperando exportación: esas variables no forman parte del
runtime actual.

## Perfil recomendado en AWS

### Aplicación

Enviar stdout/stderr a CloudWatch Logs u otro sink corporativo. Incluir y buscar
por `requestId`, `analysisId`, `phase`, provider y nivel. Nunca ingerir tokens,
passwords, contenido completo de RFCs o respuestas LLM sin una decisión formal
de clasificación y retención.

Alarmas mínimas:

- tasa de `analysis_failed`;
- corridas `running` con heartbeat vencido;
- respuestas `5xx` y `429`;
- latencia del endpoint analyze y duración de pipeline;
- fallas repetidas del provider LLM;
- deep health `error` o `degraded` sostenido.

### Amazon RDS

Monitorear al menos:

- `DatabaseConnections`;
- `CPUUtilization` y `FreeableMemory`;
- `FreeStorageSpace`;
- latencia/throughput de lectura y escritura;
- deadlocks, reinicios, failovers y eventos de mantenimiento.

El cliente abre hasta diez conexiones por proceso. Las alarmas deben considerar
réplicas de aplicación, jobs de migración y sesiones administrativas.

### Chroma y embeddings

- `/api/v2/heartbeat` de Chroma;
- documentos por colección;
- persistencia y espacio del volumen;
- latencia/falla de embeddings;
- edad/fingerprint del índice;
- frecuencia de `409 RAG_UNAVAILABLE`.

## Recovery implementado

El worker revisa leases vencidos antes de reclamar trabajo, tanto en SQLite
como en PostgreSQL. Una corrida `running` sin cancelación vuelve a `pending`
cuando vence su lease; no se marca fallida sólo por reiniciar Next. El nuevo
dueño recupera los checkpoints compatibles y los anteriores quedan protegidos
por el control de propiedad del lease.

El lease dura 180 segundos y se renueva cada 10 segundos durante la ejecución.
El polling del worker ocioso ocurre cada segundo. La señal independiente de
liveness pasa a `down` después de 60 segundos sin actualización. Ninguno de
esos intervalos sustituye los límites de fase y pipeline, gobernados por
`PIPELINE_PHASE_TIMEOUT_MS` y `PIPELINE_TIMEOUT_MS`.

El hot reload de Next no recarga el worker. Después de editar agentes, prompts
o el pipeline, esperar a que termine el trabajo activo y reiniciar `pnpm dev`
antes de validar otra corrida. Un worker vivo puede estar ejecutando una
versión anterior del código.

## Runbooks mínimos

### Pipeline detenido

1. Consultar status y heartbeat del run.
2. Buscar logs por `analysisId` y última fase.
3. Confirmar si el límite global, límite de fase, cancelación o coste lo abortó.
4. Verificar provider LLM y RAG.
5. No cambiar manualmente a `completed`; conservar la causa de falla.

### Saturación de base

1. Revisar `DatabaseConnections` y `pg_stat_activity`.
2. Relacionar conexiones con el número de tasks (`tasks * 10` como cota).
3. Identificar sesiones idle, migraciones o queries lentas.
4. Reducir réplicas o adaptar el pool antes de aumentar `max_connections`.
5. Evaluar RDS Proxy sólo después de probar el comportamiento de prepared
   statements.

### RAG no disponible

1. Consultar deep health con bearer.
2. Verificar heartbeat de Chroma.
3. Contar documentos y revisar page indices.
4. Confirmar que Ollama y el embedding model son alcanzables.
5. Reindexar sólo desde el corpus aprobado.

## SLO, RPO y RTO

El repositorio no fija valores corporativos. Deben acordarse con Product,
Security y Operaciones y luego traducirse a:

- Multi-AZ, retención/PITR y restore tests de RDS;
- estrategia de restore/rebuild de Chroma;
- timeout de proxy y pipeline;
- alertas con owner y canal de respuesta;
- retención de logs y auditoría.

El [runbook de RDS](aws-rds.md) contiene el procedimiento de backup y
restauración recomendado.
