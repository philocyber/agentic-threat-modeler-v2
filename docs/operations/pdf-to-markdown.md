# PDF to Markdown migration workflow

This workflow converts a PDF corpus, validates page/text coverage, archives originals, promotes reviewed Markdown, and optionally rebuilds the local RAG index. Originals and migration reports stay outside the indexed corpus. Run it from the repository root.

## Setup

```sh
python3 -m venv .venv-pdf
.venv-pdf/bin/python -m pip install -r scripts/requirements-pdf.txt
```

On Windows use `.venv-pdf\Scripts\python.exe`. The pinned dependencies provide local PDF parsing, layout inference, and OCR. Installation downloads packages/models; document processing does not send PDF content to an external API.

## 1. Convert into a new review directory

```sh
.venv-pdf/bin/python scripts/pdf_to_markdown.py knowledge_base --output output/pdf-review/markdown
```

You can supply any number of PDF paths instead of a directory. Directories are searched recursively, relative subfolders are preserved, and each PDF produces exactly one Markdown file. The default layout engine handles columns, headings and tables using PyMuPDF4LLM. `--engine basic` selects the simpler pdfplumber extractor for comparison; it requires particular care with multi-column content.

Each Markdown file contains source-page headings, a source SHA-256, document ID and title. `conversion-report.json` records page counts, hashes and extraction warnings. Existing Markdown or reports are never overwritten by conversion. Choose a new folder when rerunning to preserve reviewed edits.

## 2. Validate and repair extracted text

```sh
.venv-pdf/bin/python scripts/validate_pdf_markdown.py --corpus knowledge_base --converted output/pdf-review/markdown --ocr-sparse
```

This step verifies source/output hashes and exactly one ordered marker for every source page. It compares normalized word counts with the original text layer. When layout extraction omitted content, it appends source text blocks; an entire-page text supplement is used if block recovery is insufficient. These supplements preserve source wording, not inferred meaning or diagram relationships.

`--ocr-sparse` runs local RapidOCR on image-bearing pages with fewer than 15 text-layer words. Recognized lines below confidence 0.85 are omitted. OCR additions are explicitly identified in Markdown. Other figures may still need manual transcription or a visual explanation.

A document passes the text check when each nonempty text-layer page retains at least 95% of its normalized source word occurrences. This does not prove semantic fidelity, reading order, table alignment, or accurate OCR. Blank and image-only pages require review because a text-layer comparison cannot validate them. `validation-report.json` describes the scope and results. Validation updates the staging Markdown and output hashes, never the active corpus.

Review the resulting Markdown beside the original PDFs, including tables, sparse pages, OCR additions, low-retention repairs and representative unflagged pages. Preserve source qualifications. If you manually edit Markdown, update its `output_sha256` in the conversion report only after checking the edit, then rerun validation. Do not clear failures just to proceed.

## 3. Promote reviewed files and rebuild

Make sure no analysis is running, then:

```sh
.venv-pdf/bin/python scripts/promote_pdf_markdown.py --corpus knowledge_base --converted output/pdf-review/markdown --archive output/pdf-review/pdf-archive --reviewed --reindex
```

`--reviewed` records your decision to proceed after reviewing extraction quality. The script independently requires passing validation and matching hashes. It copies every original PDF to the archive and verifies those copies before replacing any active source. Existing Markdown in the destination is a conflict, not an overwrite. Failure during promotion rolls back the active changes. A migration receipt records paths and hashes. Supplemental page indices are regenerated from the same Markdown, preserving one-based source pages. Existing trees for these documents are backed up under the archive; unrelated trees are left intact. Use `--page-indices` if your app has a custom `PAGE_INDICES_PATH`.

With `--reindex`, the script starts the existing Knowledge index job through the local app, follows it to completion, and verifies live RAG readiness. The app must be running; use `--app-url http://127.0.0.1:3000` to change its loopback origin. Without `--reindex`, promotion finishes and you can start reindexing through Knowledge later. A failed reindex leaves the archived PDFs and promoted Markdown intact so you can inspect and retry it.

Only one representation of each PDF remains in the active corpus. Reindexing removes stale PDF-derived vector entries and replaces them with Markdown-derived entries. Verify a few known retrieval queries before starting a full analysis.

## Recovery and limits

- Keep the archive and `migration-receipt.json`. To revert, first verify that active Markdown still matches its receipt hash, move it outside the corpus, restore the corresponding archived PDFs, and reindex. Also restore backed-up page-index files and remove newly generated trees for reverted documents, using the receipt and `previous-page-indices` directory. Do not discard intervening edits.
- The default `knowledge_base` directory and output directories inside an input directory are rejected as conversion destinations. Always keep staging and archives outside any custom indexed corpus as well.
- Provenance fields are preserved in Markdown. The current RAG parser consumes `doc_id`, `title`, and `doc_type`; `source_pdf`, `source_sha256`, and `conversion_status` are not currently retrieval metadata. Page markers are source text, not structured PDF-page citations.
- Long Markdown tables can still span multiple RAG chunks. Figure relationships remain in the original PDF; textual extraction and OCR do not reconstruct a diagram's meaning.
- Conversion exits 0 when all files converted, 1 for per-document failures, and 2 for invalid arguments or conflicting paths. Conversion success is not review approval. Validation exits nonzero when text checks fail. Promotion/reindexing raises an error on failed safeguards or job failure.

## Tests

```sh
.venv-pdf/bin/python -m unittest discover -s scripts/tests -p 'test_pdf*.py'
```

## Retrying an incomplete index

If promotion succeeded but indexing failed, leave the promoted Markdown and archive intact. Fix the reported issue, then use **Knowledge > Reindex knowledge**. Do not run promotion again against the same output/archive paths. Keep the corpus unchanged until indexing finishes; editing it during a job causes the final consistency check to fail.

The indexer builds separate generations for technical chunks, catalog cards and corporate chunks. Within the same corpus version, retries reuse records only when the chunk ID, exact text, complete embedding input hash and metadata match. A changed corpus may require rebuilding unchanged sources too. Old generations remain stored; they are excluded from the new publication, not deleted automatically. The seven collection pointers publish together only after verification.

Read the job logs for file chunk counts and errors. RAG is unavailable while a rebuild is running or failed. Completion requires a successful job, matching corpus fingerprint and live readiness checks. The masthead refreshes every 20 seconds. Confirm **Services ready** and **Index is up to date**, then check retrieval results before launching a scan. Changed corpus fingerprints can make older run checkpoints incompatible.

Implementation: `scripts/index-knowledge-base.ts` and `lib/rag/generation.ts`. The same operator guidance appears at `/docs#knowledge-index-reuse` and `/docs#knowledge-pdf-migration` in the local app.
