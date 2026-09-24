# Despliegue de Argus como servicio

**Etapa futura:** esta guía documenta el perfil técnico de servicio; la entrega actual soportada es la PoC local. No implica SSO ni multiusuario completo.

Argus mantiene dos perfiles excluyentes:

- **Local:** sin `DATABASE_URL`, proyecto seleccionado, SQLite y artefactos en
  disco. Es el perfil de una sola persona en una máquina confiable.
- **Servicio:** con `DATABASE_URL`, PostgreSQL exclusivamente y bearer tokens
  M2M. Es el perfil adecuado para integraciones o una instancia central, pero
  todavía no ofrece identidad humana, SSO ni RBAC.

Para AWS, el perfil recomendado usa Amazon RDS for PostgreSQL. El procedimiento
detallado está en [runbook de RDS](aws-rds.md).

## Arquitectura soportada

```text
Clientes M2M o reverse proxy corporativo
                  |
               HTTPS
                  |
        Argus / Next.js          pipeline-worker
          |              |                  |
      PostgreSQL       ChromaDB        misma base
       (RDS)       (servicio persistente)
          |
   estado y resultados
```

- Next admite, consulta, cancela y muestra. El worker reclama runs con lease.
- PostgreSQL es el store central de sistemas, runs, amenazas, uploads y
  auditoría.
- Chroma aporta recuperación vectorial y debe desplegarse por separado.
- El corpus de knowledge base y el volumen de Chroma necesitan su propia
  estrategia de persistencia/restore.
- Ollama debe ser alcanzable desde la aplicación si se usa como LLM o para
  embeddings; Bedrock y otros providers requieren sus credenciales y red.

## Requisitos mínimos

- PostgreSQL 16 alcanzable con TLS.
- Node compatible con `package.json`; estandarizar Node 22 en la plataforma es
  recomendable, el contrato actual declara `>=22.13.0` y el baseline probado es 22.23.2.
- Secretos inyectados por el orquestador, nunca incluidos en la imagen.
- `SERVICE_AUTH_REQUIRED=true` y al menos un token.
- Reverse proxy que termine TLS y sobrescriba headers de forwarding.
- Timeout del proxy mayor que `PIPELINE_TIMEOUT_MS`.
- Chroma privado y con storage persistente si RAG estará habilitado.

## Variables del perfil de servicio

```dotenv
NODE_ENV="production"
DATABASE_URL="postgresql://agentictm_app:...@RDS_ENDPOINT:5432/agentictm?sslmode=verify-full"
NODE_EXTRA_CA_CERTS="/etc/ssl/certs/aws-rds-global-bundle.pem"

SERVICE_AUTH_REQUIRED="true"
SERVICE_AUTH_TOKENS="TOKEN_INTEGRATION_A,TOKEN_INTEGRATION_B"
TRUSTED_PROXY_HOPS="1"
INSTANCE_ID="UNIQUE_TASK_OR_POD_ID"

CHROMA_HOST="chromadb.internal"
CHROMA_PORT="8000"
EMBEDDING_PROVIDER="ollama"
EMBEDDING_MODEL="qwen3-embedding:4b"

PIPELINE_TIMEOUT_MS="3600000"
PIPELINE_PHASE_TIMEOUT_MS="900000"
ARCHITECTURE_CHUNK_CONCURRENCY="3"
```

Agregar sólo las variables del provider LLM autorizado. Para Bedrock, preferir
task roles/IRSA sobre access keys estáticas cuando el runtime de despliegue lo
permita.

`MAX_RUN_COST_USD` es opcional. Si se activa para un provider cloud, todos los
modelos quick/deep seleccionados deben existir en `LLM_PRICES_JSON`; de lo
contrario `/analyze` responde `409 LLM_PRICE_MISSING`.

## Orden de release

1. Crear snapshot o confirmar el punto de recuperación.
2. Ejecutar `pnpm drizzle:migrate` desde un job one-off con el rol migrator.
3. Verificar enums, tablas y grants.
4. Desplegar la aplicación con la URL del rol runtime.
5. Verificar liveness y deep health.
6. Ejecutar una corrida smoke sin información sensible.
7. Observar errores, conexiones y latencia antes de completar el rollout.

Las migraciones van antes que el código que depende de ellas. En producción no
usar `drizzle:push` ni generar migraciones durante el release.

## Health checks

`GET /api/health` es público y mínimo:

- sin `DATABASE_URL`, responde `mode: local`;
- con `DATABASE_URL`, ejecuta `SELECT 1` y responde `mode: postgres`;
- si PostgreSQL falla, responde `503` sin incluir el error interno.

`GET /api/v1/health` es deep health y está autenticado en modo servicio:

```bash
curl -fsS \
  -H "Authorization: Bearer ${SERVICE_TOKEN}" \
  https://argus.example.com/api/v1/health
```

Comprueba base, provider relevante y readiness RAG. Puede responder `degraded`
cuando la base funciona pero RAG no está usable.

## Autenticación actual

Los tokens de `SERVICE_AUTH_TOKENS` son principals M2M:

```bash
curl -fsS \
  -H "Authorization: Bearer ${SERVICE_TOKEN}" \
  https://argus.example.com/api/v1/results
```

Cada token ve sólo los registros creados por su principal. Los datos legacy sin
owner no son visibles para bearer.

Limitaciones relevantes:

- No hay login, sesión browser, SSO, MFA, grupos ni scopes.
- La UI no administra tokens ni identidades.
- El principal es un hash del token; rotarlo cambia ownership lógico.
- Un proxy que inyecta un token compartido hace que todos sus usuarios actúen
  como el mismo principal y sólo es aceptable como medida transitoria controlada.

Por eso, RDS puede usarse hoy de forma segura para M2M o una instancia interna
restringida, pero un workspace corporativo humano requiere una capa de identidad
estable antes de considerarse multi-usuario completo.

## Semántica de ejecución

- Los resultados terminales pueden ser `completed`, `partial` o `failed`.
- `partial` contiene resultados utilizables y warnings de batches/fases.
- Cancelación y coste máximo son fatales.
- Un resume incompatible devuelve `409 CHECKPOINT_INCOMPATIBLE`.
- RAG solicitado pero no usable devuelve `409 RAG_UNAVAILABLE` antes de crear el
  run.
- El sexto stream concurrente del mismo actor/run devuelve
  `429 SSE_CONNECTION_LIMIT`.

El estado, el lease y la cancelación se persisten en PostgreSQL. El grafo corre
en `pipeline-worker`. Rate limiter y contadores SSE siguen siendo memoria por
proceso de Next. El progreso local es JSONL; en PostgreSQL la UI observa el
estado de la fila. Varias réplicas de `app` no coordinan esos contadores. Cada
proceso worker necesita un `INSTANCE_ID` distinto: dos réplicas con el mismo id
pueden renovar el lease de la otra.

## Artefactos y checkpoints

En modo local se escriben manifests, progreso, telemetría, reportes y
checkpoints con hash bajo `runs/<id>/`.

En modo PostgreSQL/RDS:

- resultados, amenazas, auditoría, metadata del manifest v2 y checkpoints de
  fase se persisten en la base (`run_artifacts`);
- el worker registra liveness en `pipeline_workers`;
- un resume reutiliza fases con SHA válido, igual que en local.

## Red y secretos en AWS

- RDS, Chroma y Ollama no deben exponerse públicamente.
- El Security Group de RDS acepta `5432` sólo desde el SG de la aplicación.
- La task role sólo lee los secretos que necesita.
- Usar KMS para RDS y Secrets Manager.
- Enviar logs a un sink central sin contenido completo de inputs/prompts.
- Configurar `TRUSTED_PROXY_HOPS` según la topología real; `0` ignora
  `X-Forwarded-For` para rate limiting.

## Escalado y conexiones

El cliente actual usa un pool máximo de diez conexiones por proceso. Una
estimación inicial es `réplicas * 10`, más migraciones y administración. No
escalar réplicas sin revisar `DatabaseConnections` y el límite de RDS.

RDS Proxy puede ser útil con muchas instancias o conexiones transitorias, pero
Postgres.js usa prepared statements por defecto. Adaptar y probar ese camino
antes de depender del multiplexing del proxy.

## Rollback

- El rollback de aplicación no revierte automáticamente el schema.
- Las migraciones deben ser backward-compatible durante la ventana de rollback.
- No editar ni borrar una migración aplicada.
- Para una falla de datos, restaurar a un endpoint separado y validar antes de
  cambiar tráfico.
- Para una falla de aplicación, volver a la imagen anterior manteniendo el
  schema compatible.

## Checklist antes de producción

- RDS privado, TLS verificado y KMS habilitado.
- Master, migrator y runtime separados.
- Backups/PITR y restore testados.
- `pnpm drizzle:migrate` ejecutado desde CI/CD o una task one-off.
- `SERVICE_AUTH_REQUIRED=true` y tokens almacenados como secretos.
- Política documentada para rotar tokens sin perder ownership.
- Chroma privado, persistente y reindexable.
- Provider LLM aprobado mediante DPA y data classification.
- Alarmas de RDS, logs de aplicación y runbook de incidentes.
- Decisión explícita sobre el límite actual: M2M versus usuarios humanos/SSO.


La administración de credenciales y corpus desde la UI/API local se rechaza en este perfil. Usar configuración del operador y jobs controlados para la ingesta. El compose de servicio está separado: incluir explícitamente `docker-compose.service.yml` además del compose base. Ese compose define un servicio `worker` (`node build/pipeline-worker.cjs`) junto a `app`.
