# Runbook de PostgreSQL en Amazon RDS

Este runbook describe el perfil recomendado para ejecutar Argus con Amazon
RDS for PostgreSQL.

RDS aloja PostgreSQL; Drizzle continúa siendo la capa de consultas y
migraciones. No se integra un SDK específico de AWS en el acceso a datos:
Argus recibe una URL PostgreSQL estándar en `DATABASE_URL`.

## 1. Arquitectura recomendada

```text
Internet o red corporativa
           |
      ALB / reverse proxy
           |
  Argus en ECS, EKS o EC2
           |
       TCP 5432 privado
           |
  RDS PostgreSQL 16 Multi-AZ
```

- Aplicación y RDS en la misma región.
- RDS en subredes privadas y `Public access = No`.
- Security Group de RDS con ingreso `5432` únicamente desde el Security Group
  de la aplicación. Nunca desde `0.0.0.0/0`.
- Acceso administrativo por una tarea one-off, host administrado mediante SSM,
  VPN o red corporativa. No abrir RDS temporalmente a Internet.
- Cifrado en reposo con KMS, backups automáticos y deletion protection.
- Chroma y el runtime LLM son servicios separados; RDS no los reemplaza.

AWS documenta los controles de RDS, incluyendo VPC, TLS, cifrado y logging, en
[Security in Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.html).

## 2. Crear la instancia

En **AWS Console → RDS → Create database**:

1. Elegir `Standard create` y engine `PostgreSQL`.
2. Usar PostgreSQL 16.x para igualar el baseline local del proyecto.
3. Elegir template `Production` para producción y habilitar Multi-AZ según el
   RPO/RTO aprobado.
4. Definir un identificador, por ejemplo `agentictm-prod`.
5. Usar un master username distinto de los usuarios de aplicación. Guardar la
   credencial inicial en Secrets Manager.
6. Crear la base inicial `agentictm`.
7. Elegir una clase y storage gp3 de acuerdo con pruebas de carga; habilitar
   autoscaling de storage con un máximo controlado.
8. Habilitar cifrado KMS. Para requisitos estrictos, usar una customer-managed
   key con política y rotación corporativas.
9. Seleccionar la VPC y DB subnet group privados. Configurar
   `Public access = No`.
10. Asociar un Security Group dedicado que sólo acepte el SG de la aplicación.
11. Configurar backups automáticos, ventana de mantenimiento, deletion
    protection y copia de tags a snapshots.
12. Habilitar exportación de logs y monitoreo según la política operativa.

No fijar RPO/RTO por costumbre. Backup retention, Multi-AZ y réplicas deben
derivarse del impacto de perder threat models y del tiempo permitido para
restaurarlos.

## 3. Forzar TLS

Crear un DB parameter group para PostgreSQL 16 y mantener:

```text
rds.force_ssl = 1
```

En PostgreSQL 15 o superior AWS lo habilita por defecto, pero declararlo y
verificarlo evita depender de defaults. AWS describe el parámetro y los
certificados en [Using SSL with a PostgreSQL DB
instance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html).

Descargar el bundle global de CA de RDS dentro de la imagen o task que se
conectará:

```bash
curl -fsSLo global-bundle.pem \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

Para `psql`, verificar certificado y hostname:

```bash
psql "host=RDS_ENDPOINT port=5432 dbname=agentictm user=DB_ADMIN sslmode=verify-full sslrootcert=/path/global-bundle.pem"
```

Para la aplicación actual, la URL mínima segura es:

```dotenv
DATABASE_URL="postgresql://agentictm_app:URL_ENCODED_PASSWORD@RDS_ENDPOINT:5432/agentictm?sslmode=verify-full"
NODE_EXTRA_CA_CERTS="/etc/ssl/certs/aws-rds-global-bundle.pem"
```

La contraseña debe estar percent-encoded dentro de una URI. Evitar contraseñas
pegadas manualmente en archivos: construir y guardar la URL en Secrets Manager.

## 4. Separar roles de base de datos

No ejecutar la aplicación ni las migraciones con el master user de RDS. En una
base dedicada, crear:

- `agentictm_migrator`: propietario del schema y usado sólo por el job de
  migraciones.
- `agentictm_app`: runtime con DML, sin permiso para crear o alterar tablas.
- Opcionalmente, `agentictm_readonly`: soporte y reporting con sólo lectura.

Conectado como master, ejecutar y reemplazar los placeholders por contraseñas
generadas:

```sql
REVOKE CONNECT, TEMPORARY ON DATABASE agentictm FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE ROLE agentictm_migrator LOGIN PASSWORD 'MIGRATOR_PASSWORD';
CREATE ROLE agentictm_app LOGIN PASSWORD 'APP_PASSWORD';
CREATE ROLE agentictm_readonly LOGIN PASSWORD 'READONLY_PASSWORD';

GRANT CONNECT ON DATABASE agentictm
  TO agentictm_migrator, agentictm_app, agentictm_readonly;

ALTER SCHEMA public OWNER TO agentictm_migrator;
CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION agentictm_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO agentictm_migrator;
GRANT USAGE ON SCHEMA public TO agentictm_app, agentictm_readonly;

ALTER DEFAULT PRIVILEGES FOR ROLE agentictm_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agentictm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agentictm_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO agentictm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agentictm_migrator IN SCHEMA public
  GRANT USAGE ON TYPES TO agentictm_app;

ALTER DEFAULT PRIVILEGES FOR ROLE agentictm_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO agentictm_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE agentictm_migrator IN SCHEMA public
  GRANT USAGE ON TYPES TO agentictm_readonly;
```

Las sentencias `ALTER DEFAULT PRIVILEGES` sólo cubren objetos futuros creados
por `agentictm_migrator`. Después de la primera migración hay que conceder acceso
a los objetos ya existentes, como se muestra en la siguiente sección.

## 5. Guardar secretos

Usar secretos distintos, por ejemplo:

```text
/agentictm/prod/db/master
/agentictm/prod/db/migrator-url
/agentictm/prod/db/app-url
/agentictm/prod/service-auth-tokens
```

Sólo el job de migraciones puede leer `migrator-url`. La task role de la
aplicación puede leer `app-url`, tokens de servicio y credenciales del provider
LLM necesario. No darle acceso al secreto master.

En ECS, inyectar el secreto como variable de entorno desde Secrets Manager. En
EKS, usar el mecanismo de secretos aprobado por la organización. No incluir URLs
con credenciales en task definitions, imágenes, repositorio ni logs.

## 6. Aplicar migraciones Drizzle

Ejecutar las migraciones desde una tarea dentro de la VPC, antes de desplegar el
código nuevo. La aplicación actual sólo reconoce `DATABASE_URL`, por lo que el
job debe inyectar temporalmente la URL del migrator con ese nombre:

```bash
DATABASE_URL="postgresql://agentictm_migrator:...@RDS_ENDPOINT:5432/agentictm?sslmode=verify-full" \
NODE_EXTRA_CA_CERTS="/etc/ssl/certs/aws-rds-global-bundle.pem" \
pnpm drizzle:migrate
```

En producción usar `drizzle:migrate`; no usar `drizzle:push` ni
`drizzle:generate` como paso de release. Las migraciones del repositorio son la
fuente versionada y no deben editarse después de aplicadas.

Después de la primera migración, conectado como `agentictm_migrator`:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO agentictm_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public
  TO agentictm_app;
GRANT USAGE ON ALL TYPES IN SCHEMA public TO agentictm_app;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO agentictm_readonly;
GRANT USAGE ON ALL TYPES IN SCHEMA public TO agentictm_readonly;
```

Verificaciones mínimas:

```sql
SELECT current_database(), current_user, version();
SELECT enum_range(NULL::analysis_status);
SELECT enum_range(NULL::audit_event_type);
SELECT to_regclass('public.systems'),
       to_regclass('public.threat_models'),
       to_regclass('public.threats'),
       to_regclass('public.uploads'),
       to_regclass('public.audit_logs');
```

Los enums deben incluir `partial` y `reviewer_learning_applied`.

## 7. Configurar Argus

Variables mínimas del modo servicio:

```dotenv
NODE_ENV="production"
DATABASE_URL="postgresql://agentictm_app:...@RDS_ENDPOINT:5432/agentictm?sslmode=verify-full"
NODE_EXTRA_CA_CERTS="/etc/ssl/certs/aws-rds-global-bundle.pem"
SERVICE_AUTH_REQUIRED="true"
SERVICE_AUTH_TOKENS="TOKEN_M2M_1,TOKEN_M2M_2"
TRUSTED_PROXY_HOPS="1"
INSTANCE_ID="ECS_TASK_OR_POD_UID"
```

Además configurar Chroma y un provider LLM. Si Argus corre detrás de un ALB
que sobrescribe `X-Forwarded-For`, `TRUSTED_PROXY_HOPS=1` permite usar la IP
correcta como fallback del rate limiter. Ajustar el valor si existe más de un
proxy confiable.

El cliente PostgreSQL actual abre hasta diez conexiones por instancia. La cota
teórica es aproximadamente:

```text
tasks de Argus * 10 + migraciones + sesiones administrativas
```

Dimensionar RDS dejando margen para failover y operación. Para muchas tasks o
tráfico muy elástico, primero hacer configurable el pool y probar RDS Proxy. AWS
explica su pooling en [Amazon RDS
Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html).

## 8. Gestionar “usuarios”: dos conceptos distintos

### Roles PostgreSQL

Son identidades técnicas: master, migrator, app y readonly. Se administran con
`CREATE ROLE`, `GRANT`, `REVOKE` y Secrets Manager. Una persona no debe compartir
la credencial de `agentictm_app` para consultar la base.

Para acceso humano, preferir sesiones temporales y auditadas desde la red
corporativa. RDS soporta autenticación IAM con tokens de corta duración, pero la
aplicación actual no implementa la función dinámica de password necesaria para
usarla como runtime. AWS documenta el mecanismo en [IAM database
authentication](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.html).

### Principals de Argus

`SERVICE_AUTH_TOKENS` contiene principals M2M de la API. No son roles
PostgreSQL, no crean usuarios en RDS y no ofrecen SSO/MFA. Cada token aísla sus
runs, sistemas, uploads y reviewer learning.

El principal se deriva del token. Una rotación cambia el principal, por lo que
los registros anteriores dejan de ser visibles al token nuevo salvo que se
migre su ownership. Hasta implementar IDs estables, usar tokens por integración,
no por empleado, y planificar cada rotación con migración de datos.

## 9. Rotación de credenciales

El cliente actual construye `DATABASE_URL` al arrancar. Activar rotación
automática de un único password sin coordinar un redeploy puede dejar conexiones
nuevas usando la credencial anterior.

Procedimiento seguro actual para el runtime:

1. Crear `agentictm_app_next` con los mismos grants que `agentictm_app`.
2. Guardar una nueva URL en una versión nueva del secreto.
3. Desplegar todas las tasks con la nueva URL.
4. Verificar health y una corrida de smoke.
5. Revocar `CONNECT` al usuario anterior y finalizar sesiones restantes sólo
   durante una ventana aprobada.
6. Eliminar el rol anterior después del período de rollback.

Secrets Manager puede automatizar rotaciones de RDS, pero debe adoptarse junto
con soporte de password dinámico o un redeploy coordinado. Ver [rotación de
secretos de bases](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotate-secrets_turn-on-for-db.html).

## 10. Backups, restauración y DR

- Habilitar backups automáticos y PITR conforme al RPO.
- Crear snapshot manual antes de migraciones de alto riesgo.
- Mantener deletion protection y restringir `rds:DeleteDBInstance`.
- Probar restauraciones periódicamente en una instancia separada.
- Después de restaurar, ejecutar sólo migraciones pendientes, verificar grants,
  health y una corrida smoke.
- RDS no respalda Chroma. El índice debe reconstruirse desde el corpus aprobado o
  restaurarse mediante el mecanismo elegido para su volumen.

Procedimiento de prueba:

1. Restaurar snapshot/PITR con un endpoint nuevo.
2. Mantener la instancia aislada de producción.
3. Conectar con TLS y ejecutar las verificaciones SQL.
4. Ejecutar `pnpm drizzle:migrate` con el migrator si corresponde.
5. Levantar una task de Argus apuntando al endpoint restaurado.
6. Verificar `/api/health`, `/api/v1/health` con bearer y un análisis controlado.
7. Registrar tiempos reales de restore para validar el RTO.

## 11. Monitoreo recomendado

Crear alarmas para:

- `DatabaseConnections` respecto del límite disponible.
- `FreeStorageSpace` y crecimiento de storage.
- `FreeableMemory` y `CPUUtilization`.
- latencia y throughput de lectura/escritura.
- failovers, reinicios y eventos de mantenimiento.
- errores de autenticación y queries lentas según la política de logging.

Usar Database Insights/Enhanced Monitoring cuando el nivel de soporte y el
presupuesto lo permitan. Habilitar `pgAudit` sólo con una política de eventos y
retención definida: auditar todo puede generar volumen y exposición innecesaria.

## 12. Troubleshooting

### Timeout o `ECONNREFUSED`

- Confirmar endpoint y puerto.
- Verificar que la task está en una red con ruta hacia las subredes de RDS.
- Verificar ingreso en el SG de RDS desde el SG de la aplicación.
- Confirmar DNS y Network ACLs.

### Error relacionado con SSL o `no pg_hba.conf entry ... SSL off`

- Confirmar `sslmode=verify-full`.
- Confirmar que `NODE_EXTRA_CA_CERTS` apunta al bundle montado.
- Verificar hostname: conectarse al endpoint DNS de RDS, no a una IP.

### `password authentication failed`

- Confirmar que el secreto y el rol PostgreSQL coinciden.
- Revisar percent-encoding de la contraseña en la URL.
- Verificar si una rotación cambió la base pero no redeplegó la aplicación.

### `permission denied for table`, sequence o type

- Ejecutar los grants de objetos existentes.
- Revisar que las default privileges estén definidas **para
  `agentictm_migrator`**, que es quien crea los objetos.
- No elevar temporalmente `agentictm_app` a owner.

### `too many connections`

- Contar tasks activas y sesiones administrativas.
- Recordar que cada proceso puede abrir hasta diez conexiones.
- Reducir réplicas o adaptar el pool; evaluar RDS Proxy después de probar
  prepared statements y session pinning.

### Health público funciona pero `/api/v1/health` devuelve `401` o `503`

- `401`: falta un bearer válido.
- `503 Service authentication is not configured`: PostgreSQL está activo en
  producción pero `SERVICE_AUTH_TOKENS` está vacío.
- `503` en `/api/health`: la aplicación no pudo ejecutar `SELECT 1` contra RDS.
