# Decisiones de seguridad diferidas

Estos temas requieren una decisión de producto, legal o de plataforma. No se
consideran resueltos por los controles técnicos implementados.

## Autenticación y MFA en modo servicio

La v1 local es single-user y no implementa login de browser. El aislamiento
real en local es por **proyecto/workspace** en disco. En Postgres compartido,
producción exige `SERVICE_AUTH_TOKENS` (bearer) y ownership por
`metadata.createdBy`.

Diferido: OAuth/JWT para UI, MFA, identidad estable y scopes finos si se
despliega como producto multi-usuario (ver
[DEPLOYMENT_SERVICE.md](../operations/service.md)).

La rotación de `SERVICE_AUTH_TOKENS` también requiere una decisión: el principal
actual deriva del token y cambia al rotarlo. Hasta migrar a IDs estables hay que
definir cómo se reasigna ownership de runs, sistemas y uploads.

## DPA con proveedores LLM

Antes de procesar RFCs con datos personales o confidenciales en Gemini, Kimi o
Bedrock, formalizar un DPA y verificar residencia, retención y entrenamiento de
datos por proveedor. Ollama local sigue siendo la alternativa sin transferencia
externa.

## Retención y borrado de `raw_input`

Definir período de retención, mecanismo de borrado verificable y alcance para
backups. El TTL técnico actual no sustituye esa política.

## Rotación de la credencial PostgreSQL

El cliente actual construye `DATABASE_URL` al arrancar y no usa passwords
dinámicos. Antes de habilitar rotación automática en Secrets Manager hay que
implementar refresh/reconnect o adoptar el procedimiento blue/green de roles y
redeploy descrito en [AWS_RDS_RUNBOOK.md](../operations/aws-rds.md).

## Webhooks HMAC

El emisor ya firma payloads cuando existe un secreto configurado. Falta decidir
si la verificación HMAC debe ser un requisito contractual para todos los
receptores y cómo se distribuirán y rotarán los secretos.
