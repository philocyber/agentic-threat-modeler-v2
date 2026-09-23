# RAG knowledge base

This directory holds tool-wide reference documents used during threat analysis.
See the [runtime and Inspector guide](../docs/architecture/rag.md)
and the application guide at `/docs#rag`. Evidence v2 is implemented.

## Important

Technical and corporate corpora are shared by every analysis performed by this installation. Reviewer decisions are the only project-aware knowledge source and remain in each workspace database.

The corpus in git is **intentionally empty** (folders only). Add your own approved documents locally before indexing.

## Layout

Expected folders when you add a local corpus:

| Folder | Scope | Chroma collection |
|--------|-------|-------------------|
| `technical/` | General technical documentation, recursively indexed | `tm_technical` |
| `technical/research/` | Security research | `tm_research` |
| `technical/ai_threats/` | AI and agentic threat patterns | `tm_ai_threats` |
| `technical/books/` | Books and frameworks | `tm_books` |
| `technical/risks_mitigations/` | Risks and controls | `tm_risks_mitigations` |
| `corporate/` | Shared organizational architecture, policies, incidents and prior threat models | `tm_corporate` points to the active generation |

Create the missing directories locally as needed; they are not required for app boot.
The indexer also accepts the specialized folders directly under `knowledge_base/`.
General technical indexing excludes the specialized nested folders so that they
use their own collections. A separate `tm_technical_catalog` helps select sources.

The recursive technical indexer supports `.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`, and text-based `.pdf` files. Nested folders are recorded in chunk metadata so the whole technical corpus remains tool-aware while preserving its source grouping. The corporate synchronizer supports `.md`, `.txt`, `.json`, `.yaml`, and `.yml`.

## Prepare useful sources

Keep system, environment, effective date, source and section headings close to
the relevant claims. Distinguish observed implementation, policy requirements,
planned controls, inferred risks and unresolved contradictions. A policy does
not prove implementation; a technical attack pattern does not prove a flaw in
the system being scanned. Previous reports are historical context until their
claims are checked against the current system.

Use clean, complete text. Renaming RTF to `.md` does not convert it to Markdown.
Uploads reject RTF masquerading as Markdown with an export instruction. This
checks content format, not factual correctness. Preserve source references.

Use flat frontmatter such as:

```yaml
---
doc_id: example-service-grants
system: Example Service
aliases: [Sample App, Review Tool]
environment: production
doc_type: configuration
assertion_type: observed
source_scope: internal
---
```

The parser preserves declared metadata and recognized introductory qualifications
on sections. System/alias, environment and optional date filters prevent explicit
scope mismatches; metadata remains an untrusted declaration. Missing fields stay
unknown. Flat scalars and inline aliases are supported; nested YAML and automatic
supersession resolution are not. Put essential exceptions near their claims too.

## Upload, index and verify

1. Open `/knowledge`, choose a technical or corporate destination, and upload
   approved documents; or copy them into the corresponding local folder.
2. Run Ollama with the configured embedding model. The default is
   `qwen3-embedding:4b` (`ollama pull qwen3-embedding:4b`). Start Chroma using the
   project's service setup.
3. Run the index job in Knowledge, `make rag-index`, or `pnpm rag:index`. The job
   indexes technical collections and their catalog, then synchronizes corporate
   content. Corporate synchronization also runs when its store initializes.
4. Inspect logs and readiness. The fingerprint includes source paths/content,
   embedding model, index format and chunking parameters. **Index is up to date**
   means the fingerprint matches; it does not certify source relevance or full
   extraction/index coverage.
5. Before a RAG-enabled scan starts, the deep health gate requires Chroma, a
   non-empty vector collection and a working embedding probe. Failure returns
   `409 RAG_UNAVAILABLE` without creating the run. To proceed without retrieval,
   explicitly turn off **Knowledge retrieval** (`config.useRag=false`).
6. In results, inspect the RAG Inspector and review the findings against
   the original sources. Retrieval activity alone does not demonstrate better
   analysis quality.

The upload limit is 20 files per request, 25 MiB per file and 100 MiB total.
The corporate loader currently processes at most 500 supported files and skips
files larger than 25 MiB. Upload acceptance and inventory presence therefore do
not guarantee that a corporate document is searchable. Split large sources into
coherent sections with their scope and qualifications intact; check index logs.
Corporate PDF and CSV uploads are not supported.

## How knowledge reaches the finding

- Structured sections, contextual embeddings and section-level BM25 complement
  vectors, catalog and tree retrieval. Explicitly incompatible scopes and zero
  lexical overlap are rejected. Missing evidence stays missing.
- New corporate chunks are 1,800 characters; technical chunks are 1,200.
  Long legacy/tree passages get a relevant window up to 2,400 characters.
  Source qualifications and metadata count against the role's context budget.
- One material `EVIDENCE_GAP` can trigger one follow-up per invocation, with a
  global limit of 40 router queries. Repeated passages do not trigger another loop.
- The structured output receives original passages alongside notes. Stable IDs
  bind source version and exact window; nonexistent or altered citations are
  rejected. RAG OFF cannot create a valid retrieved reference.
- Synthesis requires explicit candidate lineage and preserves uncertainty,
  preconditions and complete mitigations available from the source candidates.
- Reviewer decisions remain project/actor-scoped. Separate few-shot learning
  may still run with retrieval disabled.
- The Inspector exposes full delivered passages, metadata, versions, selection
  diagnostics and candidate preservation. Final traces are stored locally or in
  PostgreSQL result metadata. Finding citations expand to exact quotations.
- Verified references establish source/quote integrity, not semantic proof of the
  whole finding. Review actual scope, exceptions and control evidence.

Knowledge inventory distinguishes eligibility from skipped files and explains the
reason. Eligibility means ready to index, not successfully extracted or indexed.
Corporate publication uses a checked new generation; the previous one remains
available if the replacement fails. Technical collections still update in place.

## Measuring the result

Regression tests cover integrity and retrieval failures. For a causal comparison, freeze input,
architecture, ledger, corpus, models and reviewer examples, repeat ON/OFF and use
blind review. Count valid scenarios, supported claims, preserved unknowns,
actionable mitigations, review effort and cost; neither ten findings nor many
citations establishes quality on its own.

## Corpus handling

The complete contents of `knowledge_base/` are ignored by Git except this README. Do not force-add corpus files. This protects both proprietary technical references and sensitive corporate information.

Embeddings use **Ollama** (`EMBEDDING_MODEL`, default `qwen3-embedding:4b`). Retrieved
passages are sent to the LLM provider selected for the scan; local embeddings do
not imply that generation stays local when a cloud provider is selected.
