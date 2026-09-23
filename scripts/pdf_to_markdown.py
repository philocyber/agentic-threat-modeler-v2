#!/usr/bin/env python3
"""Convert PDFs into reviewable Markdown without modifying the RAG corpus."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
import unicodedata

import pdfplumber

VERSION = 2


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def cell(value: str | None) -> str:
    return (value or '').replace('\\', '\\\\').replace('|', '\\|').replace('\n', '<br>').strip()


def markdown_table(rows: list[list[str | None]]) -> str:
    if not rows:
        return ''
    width = max(map(len, rows))
    padded = [row + [None] * (width - len(row)) for row in rows]
    # Do not assume the first source row contains column headings.
    header = '| ' + ' | '.join(f'Column {i + 1}' for i in range(width)) + ' |'
    separator = '| ' + ' | '.join('---' for _ in range(width)) + ' |'
    return '\n'.join([header, separator, *['| ' + ' | '.join(map(cell, row)) + ' |' for row in padded]])


def in_box(char: dict, box: tuple) -> bool:
    x, y = (char['x0'] + char['x1']) / 2, (char['top'] + char['bottom']) / 2
    return box[0] <= x <= box[2] and box[1] <= y <= box[3]


def convert_basic(source: Path, source_name: str) -> tuple[str, dict]:
    source_hash = digest(source)
    page_reports, sections = [], []
    with pdfplumber.open(source) as pdf:
        if not pdf.pages:
            raise ValueError('PDF has no pages')
        title = str((pdf.metadata or {}).get('Title') or source.stem).strip()
        # Sample multiple pages so a large cover title does not become body size.
        sizes = Counter(round(c['size'], 1) for p in pdf.pages[:20]
                        for c in p.chars if c.get('text', '').strip())
        body_size = sizes.most_common(1)[0][0] if sizes else 12
        for number, original in enumerate(pdf.pages, 1):
            page = original.dedupe_chars()
            flags = []
            raw = page.extract_text(x_tolerance=1) or ''
            if len(re.sub(r'\s', '', raw)) < 40:
                flags.append('sparse_text_or_scanned_page: inspect; OCR may be needed')
            if page.images:
                flags.append('images_present: diagrams and image text are not transcribed')
            if len(page.curves) > 10:
                flags.append('vector_graphics_present: inspect diagrams and charts')
            if re.search(r'[A-Za-z]{35,}', raw):
                flags.append('possible_joined_words: inspect spacing')
            if '\ufffd' in raw or '(cid:' in raw:
                flags.append('encoding_problem: inspect missing or garbled characters')
            tables = page.find_tables()
            boxes = [t.bbox for t in tables]
            text_page = page.filter(lambda obj: obj.get('object_type') != 'char'
                                    or not any(in_box(obj, box) for box in boxes))
            lines = text_page.extract_text_lines(layout=False, return_chars=True, x_tolerance=1)
            blocks = []
            for line in lines:
                text = line['text'].strip()
                if not text:
                    continue
                chars = [c for c in line['chars'] if c.get('text', '').strip()]
                size = max((c['size'] for c in chars), default=body_size)
                # Heuristic only; short, larger text is a heading candidate.
                level = 2 if size >= body_size * 1.5 else 3 if size >= body_size * 1.15 else 0
                if not level and chars and all('bold' in c.get('fontname', '').lower() for c in chars):
                    level = 3
                prefix = '#' * level + ' ' if level and len(text) < 160 else ''
                blocks.append((line['top'], line['x0'], prefix + text, line['bottom'], bool(prefix)))
                ordered = sorted(chars, key=lambda c: c['x0'])
                if any(b['x0'] - a['x1'] > body_size * 4 for a, b in zip(ordered, ordered[1:])):
                    flags.append('possible_columns: verify reading order')
            for table in tables:
                rows = table.extract()
                blocks.append((table.bbox[1], table.bbox[0], markdown_table(rows), table.bbox[3], True))
            if tables:
                flags.append('tables_detected: verify cells, merged cells, and column headings')
            # Keep source line breaks rather than joining unrelated paragraphs.
            parts, previous = [], None
            for block in sorted(blocks):
                separated = previous is None or block[4] or previous[4] or block[0] - previous[3] > body_size * 0.6
                parts.append(('\n\n' if separated else '\n') + block[2])
                previous = block
            content = ''.join(parts).strip()
            source_words = Counter(re.findall(r'\w+', raw.lower()))
            extracted_words = Counter(re.findall(r'\w+', content.lower()))
            retained = sum((source_words & extracted_words).values()) / max(1, sum(source_words.values()))
            if source_words and retained < 0.95:
                flags.append('text_retention_below_95_percent: compare against source')
            sections.append(f'## Source page {number}\n\n{content or "[No extractable text on this page.]"}')
            page_reports.append({'page': number, 'source_text_characters': len(raw),
                                 'markdown_characters': len(content), 'text_retention_ratio': round(retained, 4), 'tables': len(tables),
                                 'images': len(page.images), 'warnings': sorted(set(flags))})
            original.close()
    metadata = {
        'doc_id': 'pdf_' + hashlib.sha256(source_name.encode()).hexdigest()[:20],
        'title': title, 'doc_type': 'reference',
        'source_pdf': source_name, 'source_sha256': source_hash,
        'conversion_status': 'pending_review',
    }
    frontmatter = '\n'.join(f'{k}: {json.dumps(v, ensure_ascii=False)}' for k, v in metadata.items())
    output = f'---\n{frontmatter}\n---\n\n' + '\n\n'.join(sections) + '\n'
    return output, {'source': source_name, 'source_sha256': source_hash,
                    'status': 'pending_review', 'page_count': len(page_reports),
                    'flagged_pages': [p['page'] for p in page_reports if p['warnings']],
                    'pages': page_reports}


def words(text: str) -> Counter:
    text = unicodedata.normalize('NFKC', text).lower()
    text = re.sub(r'<br\s*/?>', '\n', text)
    text = text.replace('**', '').replace('__', '')
    text = re.sub(r'(?<=\w)-\s*\n\s*(?=\w)', '', text)
    return Counter(re.findall(r'[^\W_]+', text, re.UNICODE))


def convert(source: Path, source_name: str, engine: str = 'layout') -> tuple[str, dict]:
    if engine == 'basic':
        return convert_basic(source, source_name)
    import pymupdf
    import pymupdf4llm
    source_hash = digest(source)
    reports, sections = [], []
    pymupdf4llm.use_layout(True)
    with pymupdf.open(source) as pdf:
        if pdf.needs_pass:
            raise ValueError('Password-protected PDF; supply an unlocked local copy')
        if not len(pdf):
            raise ValueError('PDF has no pages')
        title = pdf.metadata.get('title') or source.stem
        # Page chunks preserve source page boundaries; local layout inference only.
        pages = pymupdf4llm.to_markdown(pdf, page_chunks=True, use_ocr=False, show_progress=False)
        if not isinstance(pages, list) or len(pages) != len(pdf):
            raise ValueError('Extractor did not return exactly one result per source page')
        for index, chunk in enumerate(pages):
            page, number = pdf[index], index + 1
            raw, content = page.get_text(), chunk['text'].strip()
            flags = []
            source_words, output_words = words(raw), words(content)
            retained = sum((source_words & output_words).values()) / max(1, sum(source_words.values()))
            if source_words and retained < 0.95:
                flags.append('text_retention_below_95_percent: compare against source')
            if len(re.sub(r'\s', '', raw)) < 40:
                flags.append('sparse_text_or_scanned_page: inspect; OCR may be needed')
            if '\ufffd' in content or '(cid:' in content:
                flags.append('encoding_problem: inspect missing or garbled characters')
            if re.search(r'[A-Za-z]{35,}', content):
                flags.append('possible_joined_words: inspect spacing')
            boxes = chunk.get('page_boxes', [])
            pictures = [b for b in boxes if b.get('class') == 'picture']
            tables = [b for b in boxes if b.get('class') == 'table']
            if pictures:
                flags.append('pictures_present: inspect diagrams; image pixels are not embedded')
            if tables:
                flags.append('tables_detected: verify cells and column headings')
            sections.append(f'## Source page {number}\n\n{content or "[No extractable text on this page.]"}')
            reports.append({'page': number, 'source_text_characters': len(raw),
                            'markdown_characters': len(content), 'text_retention_ratio': round(retained, 4),
                            'tables': len(tables), 'images': len(pictures), 'warnings': flags})
    metadata = {'doc_id': 'pdf_' + hashlib.sha256(source_name.encode()).hexdigest()[:20],
                'title': title, 'doc_type': 'reference', 'source_pdf': source_name,
                'source_sha256': source_hash, 'conversion_status': 'pending_review'}
    frontmatter = '\n'.join(f'{k}: {json.dumps(v, ensure_ascii=False)}' for k, v in metadata.items())
    markdown = f'---\n{frontmatter}\n---\n\n' + '\n\n'.join(sections) + '\n'
    return markdown, {'source': source_name, 'source_sha256': source_hash, 'engine': 'pymupdf4llm-layout',
                      'engine_version': pymupdf4llm.__version__, 'status': 'pending_review',
                      'page_count': len(reports), 'flagged_pages': [p['page'] for p in reports if p['warnings']],
                      'pages': reports}


def plan(inputs: list[Path], output: Path) -> list[tuple[Path, Path, str]]:
    output = output.resolve()
    result, destinations, sources = [], set(), set()
    for input_path in inputs:
        root = input_path.resolve()
        if not root.exists():
            raise ValueError(f'Input does not exist: {root}')
        if root.is_dir() and (output == root or root in output.parents):
            raise ValueError('Output must be outside each input directory; use a separate review folder')
        files = sorted(p for p in root.rglob('*') if p.is_file() and p.suffix.lower() == '.pdf') if root.is_dir() else [root]
        for source in files:
            if source.suffix.lower() != '.pdf':
                raise ValueError(f'Not a PDF: {source}')
            resolved = source.resolve()
            if resolved in sources:
                continue
            relative = source.relative_to(root) if root.is_dir() else Path(source.name)
            target = output / relative.with_suffix('.md')
            key = str(target).casefold()
            if key in destinations:
                raise ValueError(f'Output name collision: {target}. Convert these input roots separately.')
            if target.exists():
                raise ValueError(f'Output already exists: {target}. Use a new review folder to preserve reviewed edits.')
            sources.add(resolved)
            destinations.add(key)
            result.append((resolved, target, relative.as_posix()))
    if not result:
        raise ValueError('No PDF files found')
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('inputs', nargs='+', type=Path, help='PDF files or directories (recursive)')
    parser.add_argument('--engine', choices=['layout', 'basic'], default='layout')
    parser.add_argument('--output', required=True, type=Path, help='Separate, non-indexed review folder')
    args = parser.parse_args(argv)
    output = args.output.resolve()
    # Never write drafts into the default active knowledge corpus.
    corpus = Path(__file__).resolve().parents[1] / 'knowledge_base'
    if output == corpus or corpus in output.parents:
        parser.error('Choose a review folder outside knowledge_base, such as output/pdf-markdown')
    try:
        jobs = plan(args.inputs, output)
        report_path = output / 'conversion-report.json'
        if report_path.exists():
            raise ValueError(f'Report already exists: {report_path}. Use a new review folder.')
    except ValueError as error:
        parser.error(str(error))
    output.mkdir(parents=True, exist_ok=True)
    results = []
    for source, target, name in jobs:
        print(f'Converting {name} ...', flush=True)
        try:
            markdown, record = convert(source, name, args.engine)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('x', encoding='utf-8') as stream:
                stream.write(markdown)
            record['output'] = str(target.relative_to(output))
            record['output_sha256'] = digest(target)
            print(f'  {record["page_count"]} pages; {len(record["flagged_pages"])} flagged for review', flush=True)
        except Exception as error:
            record = {'source': name, 'status': 'failed', 'error': str(error)}
            print(f'  FAILED: {error}', file=sys.stderr)
        results.append(record)
        report = {'converter_version': VERSION, 'pdfplumber_version': pdfplumber.__version__,
                  'created_at': datetime.now(timezone.utc).isoformat(),
                  'review_required': True, 'documents': results}
        temp = report_path.with_suffix('.json.tmp')
        temp.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        temp.replace(report_path)
    print(f'Review report: {report_path}\nNo corpus files or Chroma collections were changed.')
    return 1 if any(r['status'] == 'failed' for r in results) else 0


if __name__ == '__main__':
    raise SystemExit(main())
