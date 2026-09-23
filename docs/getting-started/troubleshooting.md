# Resolución de problemas

- **Node o pnpm distintos:** usar `.node-version` y `packageManager` como baseline. Reinstalar con lockfile congelado; no corregir a mano el lockfile.
- **No se encuentra Docker:** ejecutar `scripts/setup.ps1 doctor` en Windows o `bash scripts/setup.sh doctor` en macOS. El launcher puede ofrecer la instalación de Docker Desktop; la aceptación de licencia, virtualización y reinicios siguen siendo decisiones del usuario.
- **CMD responde que `.` no es un comando:** `./setup.ps1` es sintaxis de PowerShell, no de Command Prompt. Desde `cmd.exe`, usar `scripts\setup.cmd` en la raíz del repositorio o `setup.cmd` dentro de la carpeta `scripts`.
- **Docker está instalado pero no responde:** completar las pantallas de primer arranque, confirmar que usa contenedores Linux y volver a ejecutar el launcher. Docker Desktop puede tardar varios minutos después de instalarse.
- **El equipo no tiene memoria o disco suficientes:** usar `-Light` en PowerShell o `--light` en Bash. Este perfil reduce modelos y contexto; no equivale al perfil estándar de mayor calidad.
- **La descarga de modelos se interrumpe:** volver a ejecutar el mismo launcher. Ollama conserva las capas completas en `ollama_data` y reutiliza lo ya descargado.
- **La corrida permanece `pending`:** Next sólo encola. Sin worker no hay ejecución. El masthead muestra `Pipeline worker down` si no hay liveness reciente. Con `pnpm dev` el worker arranca solo; con `pnpm dev:next` hay que lanzar `pnpm pipeline:worker`.
- **Worker incompatible:** un proceso vivo con código anterior. Health muestra `Worker incompatible` y `POST /analyze` responde `409 WORKER_INCOMPATIBLE`. Detener ese worker y arrancar el checkout actual con `pnpm pipeline:worker` o `pnpm dev`. Un worker caído no es incompatible.
- **Reiniciar la UI no detiene el análisis:** el grafo vive en el worker. Stop marca la fila `failed` y persiste `cancelRequestedAt`; el worker observa y aborta.
- **El stack Docker no queda saludable:** ejecutar el comando `logs` del launcher. Para el recorrido nativo, consultar `docker compose -f docker-compose.yml -f docker-compose.dev.yml logs chromadb postgres-db`. No pegar secretos de configuración en tickets.
- **Chroma ya funciona pero PostgreSQL no:** el bootstrap verifica cada dependencia. Confirmar que DATABASE_URL esté en el entorno efectivo y que el host sea local si se espera un contenedor local.
- **RAG no disponible:** revisar Ollama, el modelo de embeddings y reindexar fuentes aprobadas desde Knowledge. Para una prueba sin RAG, desactivarlo explícitamente al iniciar el análisis.
- **Knowledge tarda o falla:** se muestra un estado de carga/error y un botón de retry. Inventario y estado del índice se cargan independientemente; una falla no significa que se borraron documentos.
- **Cambió la ruta del corpus:** reiniciar el proceso después de editar la configuración; revisar Knowledge y reindexar si cambió la huella. Se admiten directorios técnicos legacy y la estructura técnica anidada.
- **Producción muestra UI pero no responde:** reconstruir con `pnpm build`, que renderiza dinámicamente las páginas con CSP nonce. Verificar el paquete completo con su script de smoke; no desactivar CSP para ocultar el problema.
- **Credenciales no se guardan:** verificar permisos del directorio y espacio libre. En servicio o contenedor con credenciales externas, gestionarlas desde el entorno del operador.
- **Cambió versión de Node y falla SQLite nativo:** reinstalar dependencias con el runtime elegido. No reutilizar `node_modules` entre arquitecturas o versiones incompatibles.
