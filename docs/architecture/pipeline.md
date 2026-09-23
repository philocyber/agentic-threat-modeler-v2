# Arquitectura del pipeline de Argus

Véase [Contexto y cobertura](context-and-coverage.md) para límites efectivos, pérdida
de información entre fases, cambios de scoring y verificaciones antes de una nueva
corrida. Una corrida completada no certifica revisión exhaustiva de los documentos.

## Objetivo y límites

El pipeline recibe descripción de sistema y documentos, extrae arquitectura,
genera candidatos con tres metodologías, los somete a debate, los sintetiza y
prioriza con DREAD.

Cada run utiliza un solo provider LLM. Retries, fallbacks y quality gates no
pueden enviar contexto a otro provider.

## Flujo

```text
request + uploads
      |
validación, ownership, RAG gate, manifest v2
      |
INSERT pending
      |
pipeline-worker reclama con lease
      |
architecture_parser
      |
STRIDE / PASTA / Attack Tree
      |
pre_dedup
      |
Red/Blue debate
      |
threat_synthesizer
      |
DREAD validator + control awareness
      |
completed | partial | failed
```

## Entrada y creación del run

`POST /api/v1/analyze`:

- aplica rate limit por actor/IP confiable;
- valida JSON, tamaño, system name, metadata, config y webhook;
- resuelve uploads del mismo owner y verifica expiración/SHA-256;
- concatena input y documentos para el fingerprint;
- resuelve o crea `System`;
- comprueba RAG cuando `useRag` está activo;
- crea un manifest v2;
- valida compatibilidad si existe `resumeFrom`;
- crea el threat model en `pending` y responde 202. No ejecuta el grafo.

Un proceso `pipeline-worker` reclama filas `pending` o `running` con lease
vencido. Next sólo admite, consulta, cancela y muestra. `pnpm pipeline:worker`
y los scripts de arranque local levantan Next y el worker juntos.

El worker publica su versión de código en el `instanceId` (`version::id`) y en
el heartbeat. Un proceso vivo con código anterior aparece como incompatible en
health; `POST /analyze` responde `409 WORKER_INCOMPATIBLE` y no encola. Un
worker caído no es incompatible: la fila puede quedar `pending`. Recuperación:
detener el proceso vivo y arrancar el checkout actual.

`systemName` es obligatorio. Un `input` vacío se admite cuando hay al menos un
`upload_id`.

## Manifest v2

El manifest guarda hashes, no contenido sensible, para:

- input resuelto;
- identidad del sistema;
- configuración semántica;
- provider/modelos;
- analistas habilitados;
- fingerprint del índice RAG;
- versión del conjunto de prompts.

Un manifest legacy o una categoría distinta produce:

```json
{
  "code": "CHECKPOINT_INCOMPATIBLE",
  "incompatible": ["models", "prompts"]
}
```

La respuesta es `409` y no expone prompts, modelos anteriores ni input.

## Fases

### Architecture parser

Genera componentes, data flows, trust boundaries, endpoints, stores, flags,
topología detallada y un fact ledger de hechos, controles, assets y assumptions.
Los secretos detectables se redactan antes de persistir el resultado final.
Las corridas nuevas preservan SRC sections originales, ajustan grupos al contexto
configurado y bloquean el análisis si falta extracción. Antes del debate, otro
gate verifica entrega completa a cada analista habilitado. Ver CONTEXT_AND_COVERAGE.md.

### Analistas

- STRIDE prioriza categorías y amenazas por componente/boundary.
- PASTA aporta escenarios y attacker profiles.
- Attack Tree modela objetivos, caminos y precondiciones.

`executionMode` controla el fan-out:

- `parallel`: los tres analistas parten de arquitectura y convergen mediante una
  barrera única.
- `hybrid`: STRIDE precede al bloque PASTA/Attack Tree, que luego converge.
- `cascade`: encadena analistas antes de dedup.

Un analista deshabilitado entrega una salida vacía válida para conservar las
dependencias del grafo.

Si un analista obligatorio (STRIDE, PASTA o Attack Tree) agota su presupuesto,
se cancelan las llamadas hermanas, no arrancan etapas posteriores y se conservan
los checkpoints ya escritos. La causa original (clase de fallo del analista) es
la primaria; las cancelaciones derivadas no se presentan como Stop del usuario.

### Pre-dedup

Primero excluye componentes explícitamente fuera de scope y calibra candidatos
con precondiciones esenciales no verificadas. Dedup reconoce mecanismos compartidos
con evidencia trazable además de embeddings/similitud léxica.

Aplica una sola puerta de confianza (`PIPELINE_CONFIDENCE_THRESHOLD`) y dedup
por embeddings. Si embeddings no están disponibles usa similitud léxica con el
mismo threshold.

Ambos caminos fusionan metodologías, evidencia, attack tree, attacker profile,
attack vector, control reference, reasoning y traceability.

### Debate

Red y Blue evalúan candidatos por batches y un judge produce verdicts. Se
persisten rondas completas en checkpoints locales. Si un batch no fatal falla,
se conservan los candidatos de ese batch y las evaluaciones exitosas del resto.
Las escrituras sucesivas de un mismo checkpoint se serializan junto con su
checksum, para que una actualización parcial no sobrescriba la marca final
de completado aunque ambas se emitan inmediatamente una después de la otra.
Una ronda contiene exactamente un turno de Red y uno de Blue. Configurar dos
rondas produce Red inicial, Blue inicial, réplica de Red y réplica de Blue;
tres rondas producen tres turnos por equipo. Todos los candidatos seleccionados
recorren las rondas configuradas, incluso si ya coinciden las severidades. No se
eliminan del diálogo los casos que acuerdan en una ronda intermedia.

En la primera ronda Blue prepara sus notas de controles con la fuente original,
sin ver la respuesta de Red; después las usa para responder. Desde la segunda,
Red recibe la respuesta anterior de Blue y Blue recibe la nueva réplica de Red,
junto con la fuente y el historial completo del candidato, sin cortar las notas
a 800 caracteres. Los equipos y el judge reciben argumentos previos sin sus
etiquetas de severidad, para reducir la copia de decisiones; cada actor debe
razonar antes de emitir aplicabilidad y severidad coherentes con sus notas.
Cada ronda conserva sus dos
turnos. `runDebateSession` espera la persistencia del par antes de iniciar el
siguiente y reanuda desde el prefijo guardado, sin repetir rondas pagadas.

El consenso se evalúa después del último turno de Blue de la última ronda
configurada. Cada finding cerrado lleva una conclusión específica (premisa que
queda en pie, aplicabilidad residual, severidad bajo precondiciones y pregunta
de verificación, o el hecho de fuente que lo rechaza). Quién la escribe depende
del perfil en `lib/agents/debate-profile.ts`: Ollama pide al judge **cada**
finding (y también un cierre interino en rondas provisionales); Kimi solo llama
al judge en desacuerdos y rechazos duales, y cierra los acuerdos con las notas
de Blue. El acuerdo de etiquetas entre equipos no sustituye esa conclusión. Un
dictamen del judge no se presenta como consenso entre equipos. El reporte final
distingue acuerdo, falta de consenso y revisión no verificada.

Aplicabilidad y severidad son decisiones separadas. Un control sin verificar
no equivale a un escenario fuera de alcance. Los IDs deben estar presentes
exactamente una vez. La conversión automática de todos los rechazos a riesgo
medio fue eliminada; una evaluación no resuelta no recibe severidad por defecto.

La copia literal o casi literal entre equipos dispara una única revisión de
Blue con su propia evidencia y sin la prosa de Red. Si persiste, o si cualquiera
de los equipos repite su turno previo en lugar de responder, el caso queda
`unresolved`. Repetir etiquetas no produce convergencia. Al agotar las rondas, los casos sin resolver marcan la
fase como degradada y el análisis como parcial. El detector textual no certifica
calidad semántica: argumentos distintos todavía pueden ser erróneos.

Los reportes anteriores conservan las respuestas originales. La vista y la API
señalan los debates copiados o modificados por la antigua salvaguarda como
pendientes de revisión, sin reescribir el artefacto histórico. El contrato de
prompts v8 impide reutilizar checkpoints del protocolo anterior como si hubieran pasado
estas reglas.

`node node_modules/tsx/dist/cli.mjs scripts/check-debate-quality.ts` ejecuta una
prueba local acotada de dos rondas con dos candidatos sintéticos, uno condicional
y otro fuera de alcance. Verifica dos turnos por equipo para cada candidato y
que el judge actúe después del último Blue. Usa Qwen en Ollama y guarda el intercambio en
`/tmp/agentic-tm-debate-local-check.json`, sin crear ni modificar análisis.
Incluye una referencia irrelevante para comprobar que no sustituya la fuente.
No usa recuperación RAG en vivo ni valida por sí sola un escaneo completo.
Las pruebas automatizadas cubren de una a cuatro rondas, acuerdos tempranos,
desacuerdos en el último turno de Blue, repetición de respuestas, reanudación
y errores de persistencia. Los adaptadores cloud se verifican con respuestas
simuladas, sin consumir sus APIs.

El Stop de la UI marca la fila `failed` y persiste `cancelRequestedAt`. El worker
lo observa y aborta su `AbortController`. Un AbortController en el proceso de
Next no alcanza un pipeline que corre en el worker.

### Síntesis

Normaliza candidatos y conserva lineage/metodologías. Los batches exitosos se
mantienen; un batch fallido usa conversión determinística únicamente para sus
candidatos.
El plan global usa un esquema con una entrada obligatoria por candidato,
decisiones enumeradas, referencias de fuente válidas y notas de longitud
acotada según el espacio disponible. Conserva una consulta adicional a RAG
para una duda concreta. La emisión recibe la arquitectura original y sus
candidatos completos; una respuesta truncada sigue siendo un error explícito.
Cada lote restringe `sourceCandidateIds` a sus IDs reales dentro del esquema
de salida. Las referencias incorrectas reciben feedback de validación y
reintentos acotados antes de recurrir a una salida de respaldo. El diagnóstico
del lote distingue errores de ejecución de referencias fuera del lote.

### DREAD y control awareness

DREAD enriquece por batches. Un batch fallido deja esos findings sin el
enriquecimiento nuevo y conserva los demás.
En Ollama, los lotes de validación se ejecutan en serie para que la espera
en la cola del mismo modelo no consuma el timeout de otra llamada. La fase
presupuesta los grupos secuenciales de lotes, con el deadline global vigente.
Los proveedores remotos conservan la concurrencia de validación configurada.

Control awareness sólo reduce score cuando un control enabled corresponde por
`controlReference`, componente o security config de traceability. Un control
potencialmente relevante pero ambiguo marca `control_verification_needed` sin
asumir cobertura.

## Structured output y retries

El camino común intenta structured output nativo con Zod. Los errores de forma
se reintentan con feedback de validación. 429 y errores de transporte
clasificados pueden aplicar backoff; errores de cliente y errores desconocidos
no deben reintentarse automáticamente.

Si se agotan fallos de validación, existe un último fallback a JSON en texto
libre. Truncación, cancelación, timeout de fase y coste máximo no se convierten
en ese fallback.

Cada respuesta registra usage normalizado por provider/modelo/agente cuando el
adapter lo expone.

## Timeouts, cancelación y coste

- `PIPELINE_TIMEOUT_MS`: presupuesto global, default 3.600.000 ms.
- `PIPELINE_PHASE_TIMEOUT_MS`: presupuesto base por fase, default 900.000 ms.
  En analistas con varias pasadas de fuentes, se multiplica por la cantidad
  planificada de pasadas, con techo en el presupuesto global. El deadline global
  no se reinicia ni se amplía; los timeouts por llamada siguen vigentes.
  En debate, cada ronda calcula sus grupos de lotes según la concurrencia:
  `ceil(lotes / concurrencia)` presupuestos base, también con techo global.
  Ollama ejecuta los lotes en serie; cuatro lotes reciben cuatro presupuestos
  base. Los candidatos, rondas y controles de evidencia no se reducen.
- Structured calls tienen sus propios timeouts/retry budget.
- El error público distingue el vencimiento de una fase del timeout de una
  llamada al modelo. Los detalles internos quedan en los logs del servidor.
- Cancelación marca `failed` y `cancelRequestedAt`; Next no aborta el grafo.
  El worker observa y aborta su `AbortController`.
- Si la renovación del lease no actualiza la fila, el worker aborta (fencing).
  Un lease vencido vuelve a `pending`; no se marca `failed`.
- Ollama propaga la señal de cada llamada al transporte HTTP, incluso antes
  del primer token. Cancelar o agotar una llamada cierra su conexión sin abortar
  otras peticiones del cliente compartido. Así no quedan llamadas antiguas en
  cola consumiendo el presupuesto de una reanudación.
- `MAX_RUN_COST_USD` aborta antes de la llamada siguiente cuando el coste
  estimado alcanzó el límite; puede excederlo como máximo por una llamada.

Cancelación, timeout de fase/global y cost cap son fatales. No se registran como
salvage parcial silencioso.

## Semántica de estados

- `pending`: fila creada, worker aún no reclamó.
- `running`: worker activo y heartbeat actualizado.
- `completed`: terminó sin degradaciones registradas.
- `partial`: entregó resultados pero una fase/batch se degradó.
- `failed`: no hay entrega válida o ocurrió error fatal/cancelación.

`completed`, `partial` y `failed` son terminales. `completed` y `partial` son
resultados entregados y pueden consultarse/exportarse; `failed` no es editable.

## Persistencia

### SQLite local

- Estado normalizado en SQLite.
- Uploads y run artifacts en el workspace.
- Cada checkpoint de fase tiene catálogo, SHA-256 y path confinado. La fase
  espera esa escritura; un fallo de I/O falla la corrida.
- Progreso/telemetría JSONL, RAG trace y quality report.
- Resume reutiliza sólo el prefijo completo con SHA válido. Un `.tmp` huérfano
  no se reanuda.
- `completed` / `partial` / `failed` se publican después de los artefactos
  finales y sus checksums.

### PostgreSQL/RDS

- Estado, amenazas, uploads, auditoría, usage agregado, errores y manifest v2 en
  PostgreSQL.
- Heartbeats, `lease_expires_at` y cancelación son durables.
- Checkpoints de fase, progreso, telemetría, quality, RAG trace y reporte se
  guardan en `run_artifacts` con SHA-256. Un payload mayor de 32 MiB falla la
  corrida en vez de truncar.
- Resume reutiliza el mismo prefijo checksumado que en local.
- Liveness del worker se registra en `pipeline_workers`.

## Progreso

SSE publica `started`, `progress`, `log`, `complete`, `error` y `timeout`.
Lee `progress.jsonl` / `telemetry.jsonl` y el estado en base. No depende del
EventEmitter in-memory del proceso de Next, que no cruza al worker.

El stream vive hasta el timeout global más dos minutos. Hay un límite de cinco
streams por actor/run y proceso.

## RAG

Cada fase puede recibir un evidence pack prefetch y tools de follow-up. El
Inspector local registra objetivos, variantes, fuentes, canales, ranks, cache y
budget sin excerpts completos.

El gate y las limitaciones actuales están en
[RAG_RETRIEVAL_AND_INSPECTOR.md](rag.md).

## Citas

El backend mantiene un catálogo determinista de pasajes originales (identificador,
sección, offsets, fingerprint NFC). El modelo selecciona identificadores SRC/RAG;
el excerpt canónico lo rellena el backend. Un ID fuera del documento o de la
recuperación de esa corrida queda `unverified`. Integridad de referencia
(`verified` / `unverified`) es distinta de relevancia (`relevant` /
`not_relevant` / `insufficient`) y de `supports` / `unlinked`. Un pasaje
existente no aprueba el hallazgo. RAG genérico no prueba una debilidad del
sistema analizado. Los campos públicos de cita se conservan para leer resultados
históricos sin reescribirlos.

Calidad no usa un mínimo de hallazgos. Esto no es entailment semántico ni
confirma una vulnerabilidad.

## Límites actuales

- Presupuestos de tokens por etapa se registran por intento (espera, carga,
  procesamiento y generación cuando el proveedor los expone). No se amplían
  los límites de ejecución para ocultar reintentos.
- `withTelemetrySpan` no exporta spans reales.
- El matching de citas es literal, no entailment semántico.
- El embedding probe RAG depende de Ollama incluso cuando el provider LLM del
  run sea cloud, porque `EMBEDDING_PROVIDER` efectivo sigue siendo Ollama.
- La caché de instancias LLM no es una caché de respuestas.
- Los precios dependen de configuración manual y pueden quedar desactualizados.
