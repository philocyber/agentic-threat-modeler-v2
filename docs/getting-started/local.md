# Uso local

El recorrido recomendado para usuarios finales es el launcher de [Docker local](../operations/docker-local.md). Requiere sólo Docker Desktop y mantiene app, worker, Ollama, modelos y Chroma dentro del stack. Esta página documenta el recorrido nativo para desarrollo con hot reload.

## Configuración

Copiar `.env.example` a `.env.local`. Las variables exportadas por el operador tienen prioridad; luego se carga `.env.local` y después `.env`. No usar `source .env.local` ni incluir secretos en Makefile o comandos que impriman sus valores.

- Sin `DATABASE_URL`: proyecto local, SQLite y artefactos bajo `AGENTICTM_WORKSPACE_ROOT` o el directorio de proyectos del usuario.
- Con `DATABASE_URL`: backend PostgreSQL exclusivo. Es una capacidad de transición, no el camino principal de esta PoC.
- `LLM_PROVIDER`: proveedor seleccionado. Un cambio a `bedrock` conserva el modo local si no se agrega DATABASE_URL.
- `KNOWLEDGE_BASE_PATH`: raíz de fuentes globales para esta instalación; inventario, fingerprint e indexador usan la misma raíz.
- `PAGE_INDICES_PATH`: índices derivados opcionales; no son necesarios para ejecutar tests.
- `CHROMA_HOST` / `CHROMA_PORT`: servicio vectorial. El bootstrap sólo levanta contenedores para hosts locales.
- `EMBEDDING_MODEL`: modelo Ollama que se usa también cuando el LLM es cloud.

## Comandos

`pnpm dev` y `pnpm dev:local` usan el mismo bootstrap nativo, preparan los servicios locales seleccionados, esperan como máximo 90 segundos por servicio y levantan Next **y** `pipeline-worker`. Requieren Node, pnpm y Ollama instalados en el host. `pnpm dev:next` omite esa preparación y no arranca el worker: las corridas quedan `pending` hasta `pnpm pipeline:worker`. Todos los servidores de uso local se enlazan a loopback.

El hot reload de Next no recarga el worker separado. Después de cambiar agentes,
prompts o el pipeline, reiniciá `pnpm dev` cuando no haya un análisis en curso.
El log debe mostrar tanto `Ready` de Next como `Pipeline worker started`.

`pnpm services:up` falla con un error accionable si no puede preparar los servicios; `pnpm dev` permite abrir la UI sin ellos y desactivar RAG explícitamente. `pnpm services:down` detiene el compose local sin borrar volúmenes.

SQLite se migra al abrir/crear un proyecto. PostgreSQL, si se elige expresamente, requiere `pnpm drizzle:migrate`. `drizzle:push` es sólo para bases descartables de desarrollo; no forma parte del quickstart.

## Datos y recuperación

Respaldar el directorio de proyectos completo: SQLite, inputs, manifests, checkpoints, artefactos y exportes. Respaldar por separado corpus y volumen Chroma. No copiar una base en escritura como único respaldo coherente; detener la PoC antes de copiar su workspace.

No subir proyectos personales, `.env.local`, índices derivados ni corpus corporativo junto al código. La distribución incluye fixtures sintéticos. Las credenciales guardadas desde la UI se escriben en `.env.local` con permisos restrictivos; una falla de escritura no bloquea intentos posteriores.

El arranque standalone conserva la ruta del archivo .env.local de la raíz mediante AGENTICTM_ENV_FILE, para que las credenciales administradas localmente sobrevivan a una reconstrucción. En Docker se suministran por entorno y la edición desde la interfaz está deshabilitada.
