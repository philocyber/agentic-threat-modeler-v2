#!/usr/bin/env python3
"""Promote reviewed PDF conversions, archive originals, and optionally reindex."""
import argparse
import json
from pathlib import Path
import shutil
import re
import time
import urllib.request
from urllib.parse import urlparse

from pdf_to_markdown import digest


def within(root, relative):
    path = (root / relative).resolve()
    if root not in path.parents:
        raise ValueError(f'Path escapes root: {relative}')
    return path


def promote(corpus, converted, archive):
    corpus, converted, archive = (p.resolve() for p in (corpus, converted, archive))
    if archive == corpus or corpus in archive.parents or converted == corpus or corpus in converted.parents:
        raise ValueError('Converted files and archive must be outside the indexed corpus')
    if archive.exists():
        raise ValueError('Archive already exists; choose a new migration archive')
    report = json.loads((converted/'conversion-report.json').read_text())
    jobs=[]
    page_names=set()
    for record in report['documents']:
        if not record.get('validation', {}).get('passed'):
            raise ValueError(f'Validation did not pass: {record["source"]}')
        source = within(corpus, record['source'])
        markdown = within(converted, record['output'])
        target = source.with_suffix('.md')
        if target.stem.casefold() in page_names:
            raise ValueError(f'Duplicate page-index filename: {target.stem}; use distinct PDF names')
        page_names.add(target.stem.casefold())
        if target.exists():
            raise ValueError(f'Active Markdown already exists: {target}')
        if digest(source)!=record['source_sha256'] or digest(markdown)!=record['output_sha256']:
            raise ValueError(f'Files changed after validation: {source}')
        jobs.append((record,source,markdown,target))
    if not jobs:
        raise ValueError('No validated conversions found')
    archive.mkdir(parents=True)
    receipt={'status':'preparing','corpus':str(corpus),'converted':str(converted),'files':[]}
    receipt_path=archive/'migration-receipt.json'
    def save():
        receipt_path.write_text(json.dumps(receipt,indent=2)+'\n')
    save()
    # Copy and verify every original before changing any active source.
    for record,source,markdown,target in jobs:
        backup=within(archive,record['source'])
        backup.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(source,backup)
        if digest(backup)!=record['source_sha256']:
            raise ValueError(f'Backup verification failed: {source}')
        receipt['files'].append({'source':record['source'],'markdown':str(target.relative_to(corpus)),
                                 'source_sha256':record['source_sha256'],'markdown_sha256':record['output_sha256']})
    receipt['status']='backed_up';save()
    created=[];removed=[]
    try:
        for record,source,markdown,target in jobs:
            # Exclusive creation prevents overwriting an intervening user edit.
            with target.open('xb') as stream:
                created.append(target)
                stream.write(markdown.read_bytes())
            if digest(target)!=record['output_sha256']:
                raise ValueError(f'Promotion verification failed: {target}')
        for record,source,markdown,target in jobs:
            if digest(source)!=record['source_sha256']:
                raise ValueError(f'Source changed during promotion: {source}')
            source.unlink();removed.append((source,within(archive,record['source'])))
    except Exception:
        for source,backup in removed:
            if not source.exists():shutil.copy2(backup,source)
        for target in created:target.unlink(missing_ok=True)
        receipt['status']='rolled_back';save()
        raise
    receipt['status']='promoted';save()
    return receipt_path


def update_page_indices(corpus, receipt_path, indices):
    corpus, indices = corpus.resolve(), indices.resolve()
    receipt = json.loads(receipt_path.read_text())
    backups = receipt_path.parent / 'previous-page-indices'
    backups.mkdir(exist_ok=True)
    indices.mkdir(parents=True, exist_ok=True)
    for record in receipt['files']:
        source = within(corpus, record['markdown'])
        if digest(source) != record['markdown_sha256']:
            raise ValueError(f'Markdown changed before page indexing: {source}')
        text = source.read_text()
        parts = re.split(r'^## Source page (\d+)\s*$', text, flags=re.M)
        nodes = []
        for i in range(1, len(parts), 2):
            number, content = int(parts[i]), parts[i+1].strip()
            blocks = re.split(r'^(#{1,6})[ \t]+(.+)$', content, flags=re.M)
            children = []
            if blocks[0].strip():
                children.append({'title': 'Page text', 'text': blocks[0].strip(), 'page_start': number, 'page_end': number})
            for j in range(1, len(blocks), 3):
                children.append({'title': blocks[j+1].strip(), 'text': blocks[j+2].strip(), 'page_start': number, 'page_end': number})
            nodes.append({'title': f'Source page {number}', 'page_start': number, 'page_end': number, 'children': children})
        title_match = re.search(r'^title: (.+)$', text, re.M)
        title = json.loads(title_match[1]) if title_match else source.stem
        payload = {'document_name': title, 'document_path': str(source), 'source_sha256': record['source_sha256'],
                   'markdown_sha256': record['markdown_sha256'], 'nodes': nodes}
        target = indices / (source.stem + '.tree.json')
        backup = backups / target.name
        if target.exists() and not backup.exists():
            shutil.copy2(target, backup)
        temporary = target.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2)+'\n')
        temporary.replace(target)
    receipt['page_indices'] = str(indices)
    receipt_path.write_text(json.dumps(receipt, indent=2)+'\n')
    print('Updated page indices:', len(receipt['files']), flush=True)


def reindex(app_url):
    parsed=urlparse(app_url)
    if parsed.scheme!='http' or parsed.hostname not in {'127.0.0.1','localhost','::1'} or parsed.path not in {'','/'}:
        raise ValueError('App URL must be a local HTTP origin')
    origin=app_url.rstrip('/')
    def request(path,method='GET'):
        req=urllib.request.Request(origin+path,method=method,headers={'Origin':origin,'Sec-Fetch-Site':'same-origin'})
        with urllib.request.urlopen(req,timeout=60) as response:return json.load(response)
    started=request('/api/v1/index','POST')
    expected=started['job']['id'];last=None
    while True:
        result=request('/api/v1/index');job=result['job']
        if job['id']!=expected:raise RuntimeError('Index job changed; inspect Knowledge')
        line=job['logs'][-1] if job['logs'] else job['status']
        if line!=last:print(line,flush=True);last=line
        if job['status']=='succeeded':break
        if job['status']!='running':raise RuntimeError(job.get('error') or 'Reindex failed')
        time.sleep(2)
    health=request('/api/v1/health')
    if not health.get('rag',{}).get('usable'):raise RuntimeError('Index completed but RAG readiness failed')
    print('RAG ready:',health['rag']['documentCount'],'indexed records',flush=True)
    return health


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus',type=Path,required=True)
    parser.add_argument('--converted',type=Path,required=True)
    parser.add_argument('--archive',type=Path,required=True)
    parser.add_argument('--reviewed',action='store_true',required=True,help='Confirm layout and OCR output have been reviewed')
    parser.add_argument('--page-indices',type=Path,default=Path('data/page_indices'))
    parser.add_argument('--reindex',action='store_true')
    parser.add_argument('--app-url',default='http://127.0.0.1:3000')
    args=parser.parse_args()
    receipt=promote(args.corpus,args.converted,args.archive)
    print('Promoted validated Markdown; archived originals:',receipt,flush=True)
    update_page_indices(args.corpus,receipt,args.page_indices)
    if args.reindex:
        health=reindex(args.app_url)
        (args.archive/'reindex-health.json').write_text(json.dumps(health,indent=2)+'\n')


if __name__=='__main__':main()
