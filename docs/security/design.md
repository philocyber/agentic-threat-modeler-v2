# Diseño de seguridad de Argus

Argus procesa arquitectura interna, controles, endpoints, variables de
entorno redactadas, amenazas y evidencia de revisión. Aunque no contenga PII,
este material debe clasificarse normalmente como confidencial.

## Trust boundaries

```text
Cliente -> reverse proxy -> API Next.js -> PostgreSQL/RDS
                                  |      -> Chroma
                                  |      -> Ollama
                                  +------> provider LLM cloud
                                  +------> webhook externo
```

Cada flecha requiere una decisión de red, identidad, cifrado y logging. La
certificación del proveedor no vuelve compliant a la aplicación; rige un modelo
de responsabilidad compartida.

## Modos de confianza

### Workspace local

- Sin `DATABASE_URL`.
- Un proyecto seleccionado usa SQLite y archivos dentro de su directorio.
- Se asume una persona dueña de la máquina.
- Las mutaciones exigen request loopback y same-origin.
- El origen se compara por esquema, host y puerto contra el `Host` HTTP validado
  como loopback (`localhost`, IPv4 `127/8` o IPv6 `::1`). Next.js normaliza las
  direcciones loopback a `localhost` en `nextUrl`, por lo que ese nombre no sirve
  para comparar el origen del navegador. No se confía en `X-Forwarded-Host` ni se
  consideran equivalentes dos hosts loopback distintos. Los clientes CLI locales
  pueden omitir `Origin`; se rechaza metadata Fetch de otro sitio.
- La cookie selecciona un ID de proyecto resuelto server-side; nunca contiene un
  path arbitrario.

No exponer este modo a Internet ni usarlo como aislamiento multi-tenant.

### Servicio PostgreSQL

- La presencia de `DATABASE_URL` selecciona PostgreSQL exclusivamente.
- Cookies/workspaces residuales no pueden cambiar el backend.
- En producción, sin `SERVICE_AUTH_TOKENS`, la API protegida falla cerrado.
- Bearer tokens válidos actúan como principals M2M y pueden mutar remotamente.
- Sistemas y threat models guardan `metadata.createdBy`; uploads tienen columnas
  de owner; reviewer learning se filtra mediante el threat model propietario.
- Registros legacy sin owner no son visibles para bearer.

Este control es aislamiento entre integraciones, no identidad corporativa. No
hay SSO, MFA, sesión browser, grupos, RBAC ni scopes.

## Endpoints de health

- `/api/health` es público, mínimo y no devuelve detalles de errores.
- `/api/v1/health` está protegido en modo servicio y expone estado de
  dependencias sólo a callers autenticados.

No publicar endpoints directos de PostgreSQL, Chroma u Ollama.

## Protección de mutaciones

`workspaceRoute` centraliza:

1. selección exclusiva de backend;
2. autenticación del modo servicio;
3. contexto del actor;
4. loopback/same-origin para actores no bearer;
5. contexto aislado del workspace.

El rate limiter usa actor si existe. Sin actor, `X-Forwarded-For` sólo se usa
cuando `TRUSTED_PROXY_HOPS` está configurado. Los buckets, al igual que el límite
SSE, son memoria por proceso y requieren un control compartido en el edge si se
escalan réplicas.

## Integridad y filesystem

- Paths locales se resuelven dentro del workspace y rechazan traversal.
- Escrituras de artefactos usan archivo temporal + rename y permisos
  restrictivos.
- Uploads y checkpoints locales tienen SHA-256; una discrepancia es corrupción.
- Uploads expirados se eliminan mediante sweep oportunista y acotado.
- Artefactos de run y checkpoints se persisten en el workspace local o en
  `run_artifacts` (PostgreSQL), siempre con SHA-256.
- La knowledge-base index state se escribe atómicamente.

En PostgreSQL los uploads se guardan como texto. RDS encryption at rest y TLS
son obligatorios para el perfil corporativo.

## Secrets

Secretos server-side actuales:

- `DATABASE_URL`.
- `SERVICE_AUTH_TOKENS`.
- credenciales de Gemini, Kimi, Cursor o AWS cuando corresponda.
- secretos de webhooks cuando se utilicen.

Reglas:

- Secrets Manager o mecanismo corporativo equivalente.
- Nunca variables `NEXT_PUBLIC_*` para secretos.
- Nunca URLs con userinfo en logs.
- Separar master, migrator y runtime de PostgreSQL.
- En AWS, preferir task roles/IRSA para Bedrock.
- Rotar `DATABASE_URL` mediante redeploy coordinado: el cliente se crea al
  arrancar y no consume passwords dinámicos.

El ID del principal M2M deriva del token bearer. Rotar el token sin migrar
ownership hace que el principal nuevo pierda visibilidad de datos previos.

## LLM y privacidad

- Cada run usa un único provider autorizado.
- Retries y quality gates no pueden cambiar de provider automáticamente.
- `allowedProviders` y `allowedProfiles` se normalizan al provider/profile
  efectivo.
- Inputs no confiables se delimitan y se redactan secretos detectables antes de
  persistir arquitectura.
- Usage y errores se registran; prompts/respuestas completos no deben enviarse a
  logs operacionales.

Antes de habilitar un provider cloud, aprobar clasificación, región, DPA,
retención, entrenamiento con datos, subprocesadores y proceso de borrado. Ollama
local reduce disclosure al vendor, pero no elimina riesgos de host, corpus o
logs.

## RAG

- Chroma se considera servicio interno sin autenticación incorporada por este
  proyecto.
- Debe quedar en red privada y aceptar tráfico sólo desde app/indexer.
- El corpus corporativo debe permanecer fuera de Git.
- RAG activo falla cerrado al iniciar si el retrieval no está usable.
- `useRag=false` es una decisión explícita del operador.
- RAG Inspector no guarda excerpts del corpus ni API keys.

El health gate exige colección vectorial no vacía y ejecuta un embedding probe.
Los page indices corruptos se aíslan por archivo y se reportan como warning.

## Webhooks

Los webhooks salientes aplican:

- sólo HTTPS;
- rechazo de destinos privados/reservados;
- DNS resuelto y fijado para evitar rebinding;
- redirects deshabilitados;
- timeout y retries acotados;
- firma HMAC cuando se configura.

El payload contiene amenazas y debe enviarse sólo a un dominio aprobado.

## Logging y auditoría

Los eventos persistibles están centralizados en `lib/db/enums.ts`. Auditoría es
best-effort y no debe considerarse un ledger inmutable por sí sola.

No registrar:

- tokens o passwords;
- `DATABASE_URL` completa;
- API keys;
- raw input completo;
- prompts/respuestas LLM completos;
- excerpts sensibles del corpus.

`logger.extractRequestMetadata` conserva headers de IP para forensics. Tanto el
logger como el rate limiter sólo calculan una IP confiable desde
`X-Forwarded-For` cuando `TRUSTED_PROXY_HOPS` representa la topología real.

## Amazon RDS

El perfil corporativo recomendado exige:

- RDS en subred privada, sin public access.
- ingreso 5432 sólo desde el SG de la aplicación.
- `rds.force_ssl=1` y verificación de hostname/CA.
- KMS, backups/PITR, deletion protection y restore tests.
- roles master/migrator/runtime separados.
- Secrets Manager y permisos IAM de mínimo privilegio.
- monitoreo de conexiones, storage, memoria, CPU y eventos.

Ver [runbook de RDS](../operations/aws-rds.md).

## Riesgos residuales prioritarios

1. **Identidad humana ausente:** los bearer tokens no sustituyen SSO/MFA/RBAC.
2. **Rate limit y SSE por proceso de Next:** no son distribuidos. El pipeline
   ya no corre dentro de Next; vive en `pipeline-worker` con lease sobre
   `threat_models`.
3. **Checkpoints sólo locales:** RDS no preserva payloads de fase para resume.
4. **Rotación de tokens:** principal inestable al cambiar el secreto.
5. **Rotación DB no dinámica:** requiere redeploy coordinado.
6. **Chroma sin auth:** depende totalmente del aislamiento de red.
7. **Prompt injection:** mitigado parcialmente, nunca eliminado.
8. **Headers IP en auditoría:** requieren edge confiable y configuración
   consistente.
9. **Auditoría best-effort:** no hay WORM, SIEM ni alertas incluidos.
10. **Artefactos sensibles:** política de retención/borrado corporativa aún debe
    aprobarse.

## Checklist de aprobación

- Data classification y owners definidos.
- Arquitectura de identidad decidida: M2M actual o SSO futuro.
- Vendor assessment y DPA de cada LLM cloud.
- RDS y Chroma privados.
- TLS y KMS verificados.
- Roles y secretos separados.
- Retención de DB, logs, uploads y corpus definida.
- Restore de RDS y reconstrucción de Chroma probados.
- Alertas con on-call/owner definidos.
