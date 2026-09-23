# Estado actual de Argus

Véase [Contexto y cobertura](context-and-coverage.md) para límites efectivos, pérdida
de información entre fases, cambios de scoring y verificaciones antes de una nueva
corrida. Una corrida completada no certifica revisión exhaustiva de los documentos.

La entrega soportada es una PoC local; el servicio compartido es una capacidad de transición con límites explícitos. Este documento describe lo que está implementado
en el repositorio, no el estado deseado de planes anteriores.

## Baseline técnico

- Next.js `16.3.4`, React `19.2.4` y TypeScript 5.
- `package.json` requiere Node `>=22.13.0`.
- Drizzle ORM sobre SQLite local o PostgreSQL remoto.
- PostgreSQL 16 es el baseline de Docker y el recomendado para Amazon RDS.
- Chroma `1.5.9` en Docker para búsqueda vectorial.
- Providers LLM: Ollama, Google Gemini, Kimi/Moonshot, AWS Bedrock y Cursor.

## Persistencia

Hay dos modos excluyentes:

1. Sin `DATABASE_URL`, una corrida requiere un proyecto local activo. Cada
   proyecto usa SQLite y guarda uploads, manifests, checkpoints, telemetría y
   artefactos bajo su propio directorio.
2. Con `DATABASE_URL`, todas las rutas usan PostgreSQL. Un workspace o cookie
   local residual se ignora y no puede cambiar el backend.

PostgreSQL contiene sistemas, threat models, amenazas, uploads, auditoría,
estado de ejecución, `run_artifacts` (checkpoints, progreso, reporte) y
`pipeline_workers`. En modo PostgreSQL los uploads se guardan como texto en la
base. Un worker que pierde el lease no marca `failed` la fila sucesora.

La cadena PostgreSQL vigente llega a `0016_run_artifacts`; SQLite llega a
`drizzle/sqlite/0005_pipeline_lease`. Las migraciones incorporan, entre
otros cambios, estado `partial`, ownership de uploads, SHA-256, lifecycle de
runs, `lease_expires_at`, artefactos de fase en PostgreSQL y
`system_id ON DELETE SET NULL`.

## Autenticación y aislamiento

- `/api/health` es liveness público y mínimo.
- `/api/v1/health` pasa por el mismo control de acceso que el resto de `/api/v1`.
- En producción con PostgreSQL, si faltan `SERVICE_AUTH_TOKENS`, las rutas
  protegidas fallan cerrado con `503`.
- Los tokens bearer configurados son principals M2M. Sistemas, runs, uploads y
  reviewer learning se filtran por principal.
- Datos PostgreSQL legacy sin owner no son visibles para principals bearer.
- Mutaciones locales/workspace exigen loopback y same-origin. Un bearer válido
  puede mutar remotamente.
- El rate limiter usa actor cuando existe; en ausencia de actor sólo confía en
  `X-Forwarded-For` cuando `TRUSTED_PROXY_HOPS` es mayor que cero. Los buckets
  tienen TTL y límite total, pero siguen siendo memoria por proceso.
- Cada actor/run admite hasta cinco streams SSE concurrentes por proceso; el
  sexto recibe `429 SSE_CONNECTION_LIMIT`.

Los bearer tokens no son un sistema de usuarios humanos. No existen login,
SSO, MFA, grupos ni roles de aplicación. Además, el ID del principal se deriva
del token; rotar un token cambia el principal y requiere migrar ownership si se
quiere conservar acceso a sus registros anteriores.

## Pipeline

- Estados: `pending`, `running`, `completed`, `partial` y `failed`.
- Manifest de reproducibilidad v2 con hashes por input, sistema, configuración,
  modelos, analistas, índice RAG y conjunto de prompts.
- Un resume con manifest legacy o incompatible recibe
  `409 CHECKPOINT_INCOMPATIBLE` y una lista de categorías incompatibles.
- Los checkpoints locales se escriben por fase, con SHA-256 y dependencia de
  prefijo íntegro. Un hash inválido es corrupción. El worker espera el checksum
  antes de continuar y antes de publicar un estado terminal.
- Next no ejecuta el grafo: un `pipeline-worker` reclama `pending` o un lease
  vencido. Un restart de la UI no mata la corrida. Stop marca la fila `failed` y
  persiste `cancelRequestedAt`; el worker observa y aborta llamadas en vuelo.
- Las citas SRC/RAG se marcan `verified` / `unverified` y `supports` / `unlinked`.
  El modelo elige identificadores de catálogo; el backend resuelve el texto.
  `relevanceStatus` es independiente de la integridad de referencia. Calidad no
  usa un mínimo de hallazgos. El matching de relevancia es léxico, no entailment.
- Si un analista obligatorio falla, se abortan hermanos y etapas posteriores;
  los checkpoints compatibles se conservan. La causa original no se sustituye
  por una cancelación derivada.
- Health y `POST /analyze` comprueban la versión de código del worker vivo.
  Un proceso anterior responde `409 WORKER_INCOMPATIBLE`.
- Coste cloud: se reserva presupuesto (incluyendo salida máxima) antes de cada
  llamada pagada cuando `MAX_RUN_COST_USD` está activo. Sin tarifa verificada
  no se llama. Si se pierde la respuesta, se conserva la reserva.
- Markdown, PDF y API distinguen `failed`, `partial` y `completed`. Un fallo
  sin hallazgos no se presenta como cero amenazas identificadas.
- Los batches de debate, síntesis y DREAD conservan resultados exitosos y
  degradan sólo el batch fallido. La corrida se entrega como `partial` con
  `pipeline_errors`.
- Cancelación, límite de coste y timeout global son errores fatales.
- `PIPELINE_PHASE_TIMEOUT_MS` es el presupuesto base por fase. Para analistas
  con múltiples pasadas de fuentes se escala por la cantidad planificada,
  siempre bajo el deadline global de `PIPELINE_TIMEOUT_MS`.
- Usage se agrega por provider, modelo y agente. El coste es una estimación
  basada únicamente en `LLM_PRICES_JSON`.
- `MAX_RUN_COST_USD` está deshabilitado cuando falta o es `<= 0`; al activarlo,
  todos los modelos cloud seleccionados deben tener precio.

- La reutilización efectiva de checkpoints funciona en local y en PostgreSQL.
  Un hash inválido es corrupción. El worker espera el checksum antes de
  continuar y antes de publicar un estado terminal.

## RAG

Al iniciar una corrida con RAG activo, `POST /api/v1/analyze` exige que el probe
considere el retrieval usable. Hoy eso significa:

- Chroma responde en `/api/v2/heartbeat`.
- Se pudo verificar al menos una colección vectorial no vacía.
- Un embedding probe real respondió con el modelo Ollama configurado.

Si el gate falla, la API devuelve `409 RAG_UNAVAILABLE`, incluyendo
`embedding_unavailable` cuando corresponde. El operador puede iniciar
deliberadamente con `config.useRag=false`.

Page indices corruptos se ignoran por archivo y aparecen como warning; no
reemplazan el requisito vectorial. El cliente compartido de embeddings memoiza
Promises en vuelo, mantiene una LRU con TTL y abre un circuit breaker por
URL/modelo después de fallos repetidos. La caché de queries RAG tiene TTL de 30
minutos y máximo de 1.000 entradas.

### Evidencia RAG v2

La ingesta conserva frontmatter plano, secciones, versiones y advertencias. El
router combina búsqueda vectorial con BM25 por sección, filtra scope incompatible,
permite un seguimiento material por invocación y limita a 40 consultas por corrida.
Los pasajes originales llegan a emisión; IDs y citas exactas se validan y se
conservan con `referenceStatus` / `supportStatus`. Una cita inventada no se
borra. Síntesis exige lineage explícito y conserva incertidumbre/precondiciones. El ledger ya no
interpreta controles desconocidos o planeados como ausentes por un booleano.

El Inspector v2 expone pasajes/versiones y candidatos representados. Las trazas
finales se guardan en artefactos de run (workspace local o `run_artifacts`).
Los checkpoints conservan evidencia y verifican hashes al resumir. La versión de
prompts impide mezclar checkpoints anteriores con este contrato.

Corporate publica generaciones verificadas sin borrar la anterior; técnico sigue
actualizando en el lugar. Los archivos admiten hasta 25 MiB; corporate limita a
500. Knowledge diferencia elegibilidad de indexación y explica omisiones. RTF mal
rotulado se rechaza. Los tests verifican integridad y regresiones, no una mejora
causal de scans completos ni entailment semántico. Few-shot learning se controla
separadamente en una comparación ON/OFF.

Ver [guía vigente y límites](rag.md) y `/docs#rag`.

## Uploads e integridad

- Uploads locales y PostgreSQL reciben SHA-256 al crearse.
- Lecturas verifican el hash; una alteración falla como corrupción.
- Los uploads tienen expiración y un sweep oportunista, acotado, se ejecuta al
  subir o iniciar análisis.
- En PostgreSQL se estampan `owner_principal_id` y
  `owner_principal_kind`; las lecturas bearer aplican ambos filtros.

## Observabilidad real

- Logs operacionales JSON por stdout.
- Auditoría best-effort en `audit_logs` para el enum compartido de eventos.
- Telemetría y progreso JSONL sólo en workspaces locales.
- Health público y deep health autenticado. `/api/v1/health` informa si
  `pipeline-worker` registró liveness reciente; el masthead y el aviso de
  `pending` distinguen cola de ejecutor caído.
- El wrapper `withTelemetrySpan` es actualmente un no-op. No hay exportador
  OTLP, métricas Prometheus, tracing distribuido, dashboard ni alertas incluidos.

## Límites operativos que afectan a producción

- El pipeline corre en un proceso worker aparte; la cola es `threat_models`.
  Rate limit y límite SSE siguen siendo memoria por proceso de Next.
- Progreso en vivo se lee de artefactos durables (JSONL local o `run_artifacts`
  en PostgreSQL) y del estado en base.
- Un worker que pierde el lease no marca `failed` la fila; el sucesor la reclama.
  Fallo y complete exigen el `workerInstanceId` dueño.
- Los checkpoints de fase se persisten también en PostgreSQL (`run_artifacts`),
  con SHA-256. Resume de fases pagadas ya no es exclusivo del workspace local.
- El pool PostgreSQL está fijado en diez conexiones por instancia.
- La URL de PostgreSQL y el cliente se construyen al arrancar; la rotación
  automática transparente de credenciales no está implementada.
- RDS Proxy no está configurado y Postgres.js usa prepared statements por
  defecto. Evaluar el proxy sólo después de adaptar y probar ese camino.
- Chroma debe desplegarse y persistirse por separado de RDS.
- La UI no implementa sesión corporativa. El bearer actual está orientado a
  integraciones M2M.
- No existe una caché de respuestas LLM activa. Las variables no implementadas fueron retiradas del ejemplo; la reutilización de instancias de modelos no es una caché de respuestas.

## Fuentes operativas

- Despliegue: [DEPLOYMENT_SERVICE.md](../operations/service.md)
- Amazon RDS: [AWS_RDS_RUNBOOK.md](../operations/aws-rds.md)
- Seguridad: [07-security/security-design.md](../security/design.md)
- Observabilidad:
  [06-observability/observability-design.md](../operations/observability.md)


## Restricciones de administración y empaquetado

Administración global de credenciales/corpus es local-only; los bearer de servicio no pueden ejecutar esas mutaciones. Las páginas con CSP nonce se renderizan por petición. El paquete standalone incorpora indexador y migraciones SQLite.
