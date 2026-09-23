# Transición de la PoC local a AWS Bedrock

Esta guía explica cómo usar Bedrock como proveedor de inferencia. Cambiar de proveedor no cambia por sí solo el perfil local de la aplicación ni prepara un despliegue compartido.

## Primer paso: conservar el modo local y cambiar el proveedor

Bedrock ya es un proveedor implementado. Seleccionar `LLM_PROVIDER=bedrock`, región y modelos aprobados. Mantener `DATABASE_URL` ausente conserva SQLite, proyectos y artefactos locales. RAG sigue requiriendo Chroma y Ollama para embeddings: elegir Bedrock no migra automáticamente ese subsistema.

Preferir credenciales temporales autorizadas para la cuenta AWS en uso. El cliente acepta la cadena estándar de credenciales AWS y variables explícitas del proveedor. No incorporar access keys al código ni al paquete. Validar disponibilidad de modelos y permisos antes de ejecutar `pnpm test:bedrock`: es una llamada real y puede consumir presupuesto.

Antes de usar documentos sensibles con un nuevo proveedor, revisar las políticas de datos de la organización y la cuenta. Configurar `MAX_RUN_COST_USD` y precios revisados si se necesita un límite de coste; una estimación no sustituye los controles presupuestarios de AWS.

## Segundo paso, separado: decidir dónde ejecutar la aplicación

Migrar el hosting a AWS requiere elegir identidad humana, permisos por operador, persistencia de artefactos/corpus, trabajos durables, backup y observabilidad. No queda habilitado por cambiar LLM_PROVIDER. El perfil [servicio](service.md) y el [runbook RDS](aws-rds.md) documentan capacidades y límites para esa evaluación posterior.

Las APIs de administración local de credenciales y Knowledge se rechazan en modo PostgreSQL compartido. Un bearer de análisis no es un operador global. Mantener esa frontera al diseñar el futuro control administrativo.

## Verificación de transición

1. Probar credenciales/modelos con un input sintético aprobado.
2. Mantener evidencia de modelo, configuración, tiempos y coste.
3. Ejecutar una comparación revisada, sin afirmar mejora causal sólo por haber cambiado el proveedor.
4. Definir criterios de aceptación y rollback antes de usar datos reales.
