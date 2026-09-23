# RAG retrieval e Inspector

Esta guía describe el contrato vigente de evidencia v2 y sus límites.

## Fuentes y alcance

El corpus técnico y el corporativo son compartidos por esta instalación. Los
filtros documentales de sistema y entorno seleccionan relevancia: **no son ACLs**.
Reviewer learning conserva el aislamiento existente de workspace/actor. Los
few-shot revisados también pueden entrar en prompts con RAG OFF; fijar ese
snapshot al comparar resultados.

The current system-level eligibility rules and evidence priority are documented in
[System review memory](review-memory.md). Reviewer decisions from another system
in the project are not selected automatically.

- `technical/` → `tm_technical`.
- `research/`, `ai_threats/`, `books/` y `risks_mitigations/`, tanto en la raíz
  como dentro de `technical/`, alimentan sus colecciones especializadas.
- `tm_technical_catalog` selecciona fuentes; se complementa con búsqueda directa
  acotada para no depender exclusivamente del catálogo.
- `corporate/` usa `tm_corporate` como puntero a una colección de generación.
- `data/page_indices/` aporta búsqueda de secciones; un archivo corrupto se
  aísla con warning.

Las políticas describen requisitos; los patrones técnicos sugieren mecanismos;
los análisis inferidos siguen siendo hipótesis. Ninguno prueba por sí solo una
configuración operativa ni la ausencia de un control.

## Ingesta y publicación

El parser conserva frontmatter plano: `doc_id`, `title`, `entity`, `system`,
`system_id`, `environment`, `as_of`, `effective_at`, `doc_type`, `source_scope`,
`assertion_type`, `sensitivity`, `aliases` y `supersedes`. Son declaraciones de
la fuente, no hechos verificados. No interpreta YAML anidado ni resuelve
relaciones `supersedes` automáticamente.

El chunking separa encabezados y busca límites de párrafo/oración. El índice
conserva sección, offsets del texto normalizado, versión SHA-256 y advertencias
introductorias reconocidas. El embedding incluye contexto documental; el pasaje
original se guarda separado. Los párrafos muy largos siguen teniendo cortes
acotados: revisar excepciones que abarcan varias secciones.

Configuración actual en `lib/rag/constants.ts`:

- Formato de índice: **4**.
- Chunks técnicos: 1.200 caracteres, overlap 180.
- Chunks corporativos: 1.800 caracteres, overlap 120.
- Ventana máxima entregada por pasaje: 2.400 caracteres; no existe el antiguo
  recorte de 420. Los chunks nuevos se entregan completos; para secciones
  legacy/tree largas se selecciona una ventana relevante.
- Máximo 40 consultas de router por corrida, incluyendo las heredadas al resumir.

Uploads: 20 archivos, 25 MiB por archivo y 100 MiB por request. La indexación
admite hasta 25 MiB por archivo y ya no limita el corpus corporativo a 500 archivos.
Un archivo soportado ilegible, vacío o demasiado grande detiene la reconstrucción;
no se omite para publicar un éxito parcial. Los formatos no soportados quedan fuera
del inventario indexable. Corporate acepta MD/TXT/JSON/YAML; técnico admite además
CSV y PDF con texto extraíble. RTF mal rotulado se rechaza.

## Reindexación por generaciones y recuperación

El formato 6 conserva `qwen3-embedding:4b`. Construye las cinco colecciones técnicas,
el catálogo y corporate en generaciones separadas del índice publicado. Cada lote
verifica mediante lectura posterior los IDs, textos y metadatos guardados. Después
verifica los conteos, el inventario de fuentes y que el corpus no haya cambiado.
Sólo entonces reemplaza atómicamente `.rag-index-state.json`, que señala las siete
colecciones publicadas. Los lectores y las comprobaciones de disponibilidad utilizan
esos nombres; las colecciones incompletas no prueban disponibilidad.

Una falla conserva el índice publicado y los lotes terminados de la reconstrucción.
Reintentar con el mismo corpus, modelo y formato reutiliza los chunks cuyo texto,
metadatos y hash del input completo coinciden. Las lecturas a Chroma son por lotes
de 16 registros, con una sola llamada de embeddings a la vez en el indexador. Las
entradas preparadas de cada colección todavía se mantienen en memoria. Cambiar el
corpus técnico genera otra generación y puede requerir reembeddings de fuentes
sin cambios; esta implementación garantiza reanudación, no una caché global entre
versiones diferentes del corpus. El catálogo también reutiliza lotes coincidentes.

Las generaciones anteriores se conservan; no hay limpieza automática de Chroma.
Esto consume almacenamiento adicional. No borrar generaciones manualmente mientras
hay lectores o reconstrucciones activos. RAG permanece bloqueado durante un job en
curso o fallido. Un índice anterior al formato 6 requiere reconstrucción y ya no se
adopta como válido sólo por sus logs. El indicador consulta salud cada 20 segundos.

El chunking conserva los bloques de código y tablas que caben en un fragmento.
Los bloques largos se dividen, conservando contexto de encabezados o apertura del
bloque separado de la cita exacta. Una comprobación determinista verifica offsets,
texto exacto y cobertura de todos los caracteres no blancos del cuerpo normalizado.
Esto no certifica extracción PDF/OCR, comprensión de tablas ni relevancia semántica.
El frontmatter se interpreta como metadatos reconocidos; los campos desconocidos no
forman parte de esa garantía de cobertura. Revisar la conversión antes de indexar.

La disponibilidad en vivo también prueba el modelo de embeddings. Ollama puede
tardar varios segundos en cargarlo después de usar memoria para un modelo de
generación; el probe permite hasta 30 segundos para ese arranque en frío. Un
fallo del embedding bloquea retrieval, pero no se reporta como una caída de
Chroma: `rag.status` refleja Chroma y `rag.usable` refleja el conjunto completo.

Para migrar PDFs, seguir [el flujo PDF a Markdown](../operations/pdf-to-markdown.md):
conversión en staging, validación, revisión visual, archivo de originales,
promoción, actualización de árboles e indexación. Si falla sólo el índice,
reintentar desde Knowledge sin repetir la promoción. Validar consultas conocidas;
la cobertura textual no certifica relaciones visuales ni calidad del ranking.

## Recuperación por pregunta

`RAGQueryRequest` recibe `query`, hasta ocho `facets`, sistema, entorno, fecha de
corte opcional y propósito. El propósito se conserva en el contrato; las
políticas de selección siguen determinadas por el rol. El objetivo admite hasta
1.000 caracteres y genera hasta dos variantes de 1.800, intercalando tecnologías,
controles y assets en los hints.

El router combina catálogo/chunks técnicos, búsqueda técnica directa, árboles,
vectores corporativos, BM25 por sección y decisiones humanas. Blue y validator
incluyen `aiThreats`. Reviewer search filtra coincidencias en el historial
autorizado antes de limitar su pool a 100 registros.

Los candidatos pasan por:

1. Exclusión de sistemas o entornos declarados incompatibles; aliases planos
   ayudan a resolver nombres. Si se suministra `asOf`, se excluyen fechas futuras.
   Sin metadata, el alcance sigue desconocido, no verificado.
2. Exclusión de documentos `doc_type: playbook` salvo preguntas sobre
   RAG/retrieval/indexing/embedding. Mantener ese tipo sólo para playbooks de RAG.
3. Ranking BM25 sobre la sección entregada y la pregunta/facets. Cero coincidencia
   léxica se descarta, incluso en candidatos vectoriales: puede reducir recall de
   sinónimos y traducciones; evaluar casos multilingües.
4. Deduplicación y diversidad (máximo dos pasajes por fuente) antes de cuotas.
5. Presupuesto del texto renderizado, incluyendo metadata y calificaciones.

Presupuestos de caracteres por consulta: analyst 9.000; Red y Blue 8.000;
synthesis 10.000; validator 6.500. Son límites de caracteres, **no un tokenizer**.
`RAG_TOP_K` amplía candidatos técnicos; no elimina cuotas ni presupuestos.
Los pasajes heredados y la única búsqueda adicional pueden ampliar el contexto
de emisión; estos límites no equivalen a un límite global de tokens facturados.
El guard de Ollama falla explícitamente si el paquete de evidencia excede su
contexto, en vez de recortar citas o excepciones. Usar un contexto suficiente
para la arquitectura y las evidencias, y revisar fallbacks de fase en Telemetry.

Cada llamada devuelve `EvidencePack` v2 con `retrieved`, `no_evidence` o
`budget_exhausted`, ID de consulta y pasajes. No se llenan cuotas con resultados
sin coincidencia. Fallos parciales de servicios se registran en logs; una ausencia
de resultados no certifica ausencia de vulnerabilidad ni de control.

## Generación, seguimiento y síntesis

La fase de notas recibe el paquete y puede declarar `EVIDENCE_GAP: pregunta`.
Se permite **una sola consulta adicional por invocación**, seguida de una revisión
de notas únicamente si trae IDs nuevos. Si no trae evidencia nueva, la cuestión
permanece pendiente. No hay bucle abierto; el límite de 40 consultas también
aplica. Los reintentos no reinician el permiso de seguimiento.

La emisión estructurada recibe notas **y pasajes originales**. Un registro por
corrida comparte los pasajes citados en el payload entre etapas. Todo texto
recuperado y su metadata permanece en bloques de contenido no confiable.

Los IDs `RAG-…` dependen de dominio, fuente, versión, chunk y ventana exacta;
no de la posición en la respuesta. La validación determinista exige referencia
entregada y cita textual contigua. Una referencia inventada o una cita alterada
se conserva con `referenceStatus: unverified` (y `supportStatus: unlinked` si
el excerpt no nombra el componente). No se borra. El conteo de rechazos sigue
siendo diagnóstico. `referenceStatus: verified` significa **fuente y cita
comprobadas**, no que una frase extraída demuestre semánticamente toda la
afirmación.

Síntesis recibe candidatos completos y exige `sourceCandidateIds` válidos de su
batch. Ya no adivina procedencia por compartir un componente. La reconciliación
sólo fusiona por lineage explícito, conserva precondiciones y estados conditional /
control_verification_needed y recupera candidatos omitidos hasta el target
configurado (máximo 15). Un mecanismo de costo no hereda evidencia de identidad
por el solo hecho de pertenecer a la misma VM. La corrección semántica de una
asignación hecha por el modelo aún requiere revisión.

El ledger conserva controles desconocidos, no verificados o planeados, incluso
cuando el parser emite un booleano `isEnabled`. La síntesis restaura mitigaciones
completas disponibles si recibe una terminada en elipsis; el enriquecimiento
DREAD no reemplaza una mitigación por otra truncada. `quality.json` registra anclas de arquitectura y referencias RAG verified /
unverified / unlinked, y mitigaciones vacías/truncadas, junto a sus heurísticas
previas. `passed` no usa un mínimo de hallazgos. No constituye un benchmark de
calidad adjudicado.

## Inspector, persistencia y reanudación

El Inspector v2 muestra pregunta, variantes, fuente/dominio, pasajes completos,
versión, metadata, rankings, descartes por razón, caracteres renderizados, cache
y latencia. Registra candidatos representados y no retenidos; ese estado muestra
preservación hasta el resultado final, no una explicación semántica de cada descarte.
Cada finding permite abrir sus citas exactas, versión, scope y calificaciones.

Las trazas finales se guardan en `runs/<id>/rag-trace.json` en local y en
`metadata.rag_trace` para PostgreSQL, bajo la autorización del resultado.
Los checkpoints de fase incluyen el registro de evidencia. Al resumir,
se comprueban hashes de artefactos y se restauran IDs/pasajes sin duplicarlos.
La versión de prompts cambió para el contrato de evidencia v2; los checkpoints
incompatibles no se mezclan con el nuevo contrato.

Los runs históricos v1 conservan su vista de metadata. No se inventan los
pasajes que no fueron capturados. Las trazas v2 contienen texto del corpus:
aplicar a los artefactos las mismas reglas de acceso, backup y retención que a
los informes. PostgreSQL almacena la traza, no el índice vectorial.

## Operación

Embeddings: Ollama, por defecto `qwen3-embedding:4b`. El cliente compartido usa
batching, memoización en vuelo, LRU y circuit breaker. Query cache incluye
host/puerto, modelo y path de corpus y se invalida al publicar un índice; reviewer
learning se consulta dentro del scope autorizado, no en esa caché vectorial.

Con RAG solicitado, `POST /api/v1/analyze` exige heartbeat de Chroma, una colección
vectorial no vacía y un embedding real. Si falla, devuelve `409 RAG_UNAVAILABLE`
sin crear el run. Desactivar `useRag` explícitamente permite trabajar sin retrieval.
El health profundo requiere bearer en modo servicio. En AWS, mantener Chroma y
Ollama privados, con persistencia y monitoreo. Los pasajes se envían al provider
seleccionado para el scan: embeddings locales no implican generación local.

## Verificación y evaluación

Después de indexar, ejecutar `pnpm exec tsx scripts/verify-rag-evidence.ts`
para verificar readiness, metadata e integridad de citas sobre el corpus local.
Esta verificación no genera nuevos scans. Los conteos de documentos y chunks
dependen de las fuentes de cada instalación.

Los tests de `lib/rag/__tests__/evidence-integrity.test.ts`, `router.test.ts`,
`trace.test.ts`, `lib/agents/__tests__/two-phase.test.ts`, `reconcile.test.ts` y
`lib/architecture/__tests__/fact-ledger.test.ts` ejercitan los fallos observados:
citas OFF inventadas, excepción posterior al carácter 420, objetivo posterior
al carácter 240, scope incompatible, pérdida entre notas y emisión, seguimiento
acotado, confusión entre costo e identidad y desconocido convertido en ausencia.

Para medir mejoras de calidad, fijar input limpio, arquitectura, ledger,
corpus, provider/modelos, prompts y aprendizaje revisado, repetir ON/OFF y revisar
casos reservados a ciegas. Medir escenarios válidos únicos, citas que realmente
sostienen afirmaciones, desconocidos conservados, mitigaciones, revisión humana,
tokens y latencia. Más documentos, citas o findings no prueban mejor calidad.
## Complete embedding inputs

Embedding requests preserve the full prepared chunk, including its metadata, section path and qualifications. They use Ollama `truncate: false`: inputs exceeding the model context fail explicitly instead of silently producing vectors for a shortened prefix. Corpus chunking remains separate from this transport policy; the retrieval router still constructs bounded search queries.

Index format 6 requires rebuilding existing vectors with the same embedding model.
Full embedding inputs include the chunk and its context, with `truncate: false`.
A character count is not a token budget: 1,200 characters do not guarantee that
metadata plus text fit every model input. An overflow fails explicitly rather than
silently truncating or dropping the source. There is no automatic recursive split
on embedding errors. Inspect the error before changing source structure or retrying.
Vector responses must have the expected count, finite numeric values, nonempty
vectors and consistent dimensions within the batch. A successful reindex proves
these storage and coverage checks passed, not that every retrieval will be relevant.
