# Cambios

## Sin publicar

- Diagnósticos por intento, clases de fallo y aborto de analistas obligatorios con causa original.
- Citas canónicas por identificador SRC/RAG; relevancia separada de integridad. Resultados históricos siguen legibles.
- Un camino de emisión por proveedor, cola Ollama de una llamada activa, reserva de coste cloud y versión de código del worker.
- Informes Markdown/PDF/API distinguen failed/partial/completed; un fallo vacío no concluye cero amenazas.
- Debate: una reparación funcional si Blue/Red copian al contrario o repiten su turno anterior. Ollama local se evalúa con modelos que caben en el host; 27B no es el camino.
- Debate por proveedor: Ollama prioriza revisión y reparación exhaustivas; Kimi reduce llamadas con evidencia incorporada y juez sólo para disputas; Cursor usa lotes amplios con reserva de salida. Las conclusiones acordadas, resúmenes provisionales y fallos del juez conservan semánticas separadas.
- Kimi live acceptance uses a fictional architecture and a bounded call and cost budget.
- `pnpm build` usa `next build --webpack` (mismo motor que `pnpm dev:next`). Turbopack de producción no empaqueta `@cursor/sdk`.
- Cada fase espera checkpoint y SHA antes de continuar; un error de escritura falla la corrida.
- `pnpm dev` y el compose local levantan Next y el worker juntos. `app` depende de `worker`; cada proceso genera su propio `INSTANCE_ID` si no está fijado.
- Fallo y complete están cercados al dueño del lease. Health y la UI muestran si el worker está vivo o incompatible. PostgreSQL persiste checkpoints de fase en `run_artifacts`.
- Entrega definida como PoC local, con transición a AWS Bedrock documentada.
- Knowledge distingue carga y fallos de datos vacíos, permite reintentar y muestra el inventario completo.
- Resolución unificada de rutas del corpus, incluyendo directorios técnicos heredados.
- Restricción de administración global en modo de servicio y recuperación de escrituras de credenciales tras errores.
- Renderizado por solicitud para aplicar el nonce CSP y empaquetado del indexador y migraciones en standalone.
- Arranque local con servicios seleccionados según configuración y esperas acotadas.
- Actualización de dependencias, fixtures sintéticos y distribución de código mediante lista explícita.
- Documentación vigente separada del historial local de revisiones y agentes, excluido de la distribución.
