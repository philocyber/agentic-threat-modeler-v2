#!/usr/bin/env python3
"""Validate page coverage and recover omitted source blocks and sparse-page OCR."""
import argparse
import json
from pathlib import Path
import re

import pymupdf
from pdf_to_markdown import digest, words


def recover_blocks(page, content):
    original = words(page.get_text())
    current = words(content)
    ratio = sum((original & current).values()) / max(1, sum(original.values()))
    added = []
    if original and ratio < .95:
        for block in page.get_text('blocks', sort=True):
            if block[6] != 0:
                continue
            text = block[4].strip()
            block_words = words(text)
            missing = block_words - current
            if missing and (sum(missing.values()) >= 3 or sum(missing.values()) >= sum(block_words.values()) * .2):
                added.append(text)
                current.update(block_words)
        if added:
            content += '\n\n### Supplemental source-page text\n\n' + '\n\n'.join(added)
    remaining = sum((original & words(content)).values()) / max(1, sum(original.values()))
    if original and remaining < .95:
        content += '\n\n### Source text transcription\n\n' + page.get_text(sort=True).strip()
        added.append('full-page text fallback')
    return content, len(added)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, required=True)
    parser.add_argument('--converted', type=Path, required=True)
    parser.add_argument('--ocr-sparse', action='store_true', help='Local OCR for sparse nonblank pages')
    args = parser.parse_args()
    root = args.converted.resolve()
    report_path = root / 'conversion-report.json'
    report = json.loads(report_path.read_text())
    ocr = None
    if args.ocr_sparse:
        from rapidocr import RapidOCR
        ocr = RapidOCR()
    validations = []
    for document in report['documents']:
        if document['status'] == 'failed':
            raise ValueError(f'Failed conversion: {document["source"]}')
        source = (args.corpus / document['source']).resolve()
        destination = (root / document['output']).resolve()
        if args.corpus.resolve() not in source.parents or root not in destination.parents:
            raise ValueError('Document path escapes configured roots')
        if digest(source) != document['source_sha256'] or digest(destination) != document['output_sha256']:
            raise ValueError(f'Hash mismatch: {document["source"]}; preserve and review changed files separately')
        markdown = destination.read_text()
        parts = re.split(r'^## Source page (\d+)\s*$', markdown, flags=re.M)
        checks = []
        with pymupdf.open(source) as pdf:
            if [int(n) for n in parts[1::2]] != list(range(1, len(pdf)+1)):
                raise ValueError('Missing, duplicated or reordered page markers')
            for i, page in enumerate(pdf):
                content = parts[i*2+2].strip()
                content, recovered = recover_blocks(page, content)
                raw_words = words(page.get_text())
                ocr_lines = (content.split('### Text recognized from the source image\n\n', 1)[1].splitlines()
                             if '### Text recognized from the source image\n\n' in content else [])
                if ocr and sum(raw_words.values()) < 15 and page.get_images() and '### Text recognized from the source image' not in content:
                    import numpy as np
                    pix = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
                    image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
                    result = ocr(image[:, :, ::-1].copy())
                    if result.txts:
                        ocr_lines = [text for text, score in zip(result.txts, result.scores) if score >= .85]
                    if ocr_lines:
                        content = content.replace('[No extractable text on this page.]', '').strip()
                        content += '\n\n### Text recognized from the source image\n\n' + '\n'.join(ocr_lines)
                current = words(content)
                retained = sum((raw_words & current).values()) / max(1, sum(raw_words.values()))
                checks.append({'page': i+1, 'source_words': sum(raw_words.values()),
                               'text_retention_ratio': round(retained, 4), 'recovered_blocks': recovered,
                               'ocr_lines': ocr_lines, 'text_check_passed': not raw_words or retained >= .95})
                parts[i*2+2] = '\n\n' + content + '\n\n'
        rebuilt = parts[0] + ''.join('## Source page ' + parts[i] + parts[i+1] for i in range(1,len(parts),2))
        destination.write_text(rebuilt)
        document['output_sha256'] = digest(destination)
        document['validation'] = {'pages': checks, 'passed': all(c['text_check_passed'] for c in checks),
                                  'scope': 'Text and page coverage, not a semantic audit of diagram relationships.'}
        validations.append({'source': document['source'], **document['validation']})
        report_path.write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
        print(document['source'], 'PASS' if document['validation']['passed'] else 'REVIEW',
              'recovered blocks',sum(c['recovered_blocks'] for c in checks),
              'OCR pages',sum(bool(c['ocr_lines']) for c in checks),flush=True)
    (root/'validation-report.json').write_text(json.dumps(validations,indent=2,ensure_ascii=False)+'\n')
    return 0 if all(v['passed'] for v in validations) else 1


if __name__ == '__main__':
    raise SystemExit(main())
