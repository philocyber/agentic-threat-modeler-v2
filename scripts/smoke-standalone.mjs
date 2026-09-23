// Isolated production contract: no real documents, databases or LLM calls.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
const bundle = resolve(process.argv[2] || '.next/standalone')
const root = await mkdtemp(join(tmpdir(), 'agentictm-standalone-smoke-'))
const collections = new Map(), records = new Map()
const mock = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  const data = JSON.parse(raw || '{}'), path = req.url
  let result = {}, status = 200
  if (path === '/api/embed') result = { embeddings: data.input.map(() => [0.1, 0.2, 0.3, 0.4]) }
  else if (path.endsWith('/heartbeat')) result = { 'nanosecond heartbeat': 1 }
  else if (path.endsWith('/pre-flight-checks')) result = { max_batch_size: 1000 }
  else if (path.endsWith('/identity')) result = { user_id: 'synthetic', tenant: 'default_tenant', databases: ['default_database'] }
  else if (path.includes('/collections')) {
    const tail = path.split('/collections')[1].replace(/^\//, ''), [id, action] = tail.split('/')
    if (!tail) {
      if (req.method === 'POST') {
        if (!collections.has(data.name)) collections.set(data.name, { id: randomUUID(), name: data.name, metadata: data.metadata, configuration_json: {}, tenant: 'default_tenant', database: 'default_database', dimension: 4 })
        result = collections.get(data.name)
      } else result = [...collections.values()]
    } else {
      const collection = [...collections.values()].find(c => c.name === id || c.id === id)
      if (!collection) { status = 404; result = { error: 'NotFoundError', message: 'Missing synthetic collection' } }
      else {
        if (!records.has(collection.id)) records.set(collection.id, new Map())
        const rows = records.get(collection.id)
        if (!action) { if (req.method === 'PUT') collection.metadata = data.new_metadata; result = collection }
        else if (action === 'count') result = rows.size
        else if (action === 'get') result = { ids: [...rows.keys()], documents: null, metadatas: null, embeddings: null, included: [] }
        else if (action === 'upsert') data.ids.forEach((key, i) => rows.set(key, data.documents[i]))
        else if (action === 'delete') data.ids.forEach(key => rows.delete(key))
        else status = 404
      }
    }
  } else if (path.includes('/tenants/')) result = { name: path.split('/').at(-1), id: randomUUID(), tenant: 'default_tenant' }
  else status = 404
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result))
})
let child, logs = ''
async function eventually(fn, milliseconds = 30_000) {
  const end = Date.now() + milliseconds
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('Production smoke timed out')
}
function syntheticPdf() {
  const stream = 'BT /F1 12 Tf 50 700 Td (Synthetic PDF security guide: review access.) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let pdf = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i+1} 0 obj\n${object}\nendobj\n` })
  const xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return pdf
}
try {
  await mkdir(join(root, 'knowledge/technical'), { recursive: true })
  await mkdir(join(root, 'knowledge/corporate'), { recursive: true })
  await writeFile(join(root, 'knowledge/technical/guide.pdf'), syntheticPdf())
  await writeFile(join(root, 'knowledge/corporate/policy.md'), '# Synthetic policy\nReview sample access quarterly.\n')
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening')
  const mockPort = mock.address().port
  const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening')
  const appPort = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve))
  child = spawn(process.execPath, [join(bundle, 'server.js')], { cwd: bundle, env: { ...process.env, DATABASE_URL: '', NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(appPort), AGENTICTM_WORKSPACE_ROOT: join(root, 'projects'), AGENTICTM_ENV_FILE: join(root, '.env.local'), KNOWLEDGE_BASE_PATH: join(root, 'knowledge'), CHROMA_HOST: '127.0.0.1', CHROMA_PORT: String(mockPort), OLLAMA_BASE_URL: `http://127.0.0.1:${mockPort}`, LLM_PROVIDER: 'ollama', EMBEDDING_PROVIDER: 'ollama' }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', c => { logs = (logs + c).slice(-8000) }); child.stderr.on('data', c => { logs = (logs + c).slice(-8000) })
  const base = `http://127.0.0.1:${appPort}`
  await eventually(async () => { try { return (await fetch(base + '/api/health')).ok } catch { return false } })
  const page = await fetch(base + '/knowledge'), html = await page.text()
  const nonce = page.headers.get('content-security-policy').match(/'nonce-([^']+)'/)[1]
  const scripts = [...html.matchAll(/<script([^>]*)>/g)]
  assert(scripts.length > 0 && scripts.every(s => s[1].includes(`nonce="${nonce}"`)))
  const nextPage = await fetch(base + '/knowledge')
  assert(!nextPage.headers.get('content-security-policy').includes(`'nonce-${nonce}'`))
  const project = await fetch(base + '/api/v1/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: 'Synthetic smoke' }) })
  assert.equal(project.status, 201, await project.text())
  const index = await fetch(base + '/api/v1/index', { method: 'POST', headers: { Origin: base } })
  assert(index.ok, await index.text())
  let completed
  await eventually(async () => {
    completed = await (await fetch(base + '/api/v1/index')).json()
    if (completed.job.status === 'failed') throw new Error(completed.job.logs.map(l => l.slice(0,500)).join('\n'))
    return completed.job.status === 'succeeded'
  })
  assert.equal(completed.index.sourceCount, 2); assert.equal(completed.index.needsReindex, false)
  assert([...records.values()].some(rows => [...rows.values()].some(text => text.includes('Synthetic PDF security guide'))), 'PDF text must reach the vector index')
  console.log('Standalone smoke passed: per-request CSP, SQLite project, PDF extraction, technical/corporate indexing and persisted readiness. Services were synthetic.')
} catch (error) { console.error(logs); throw error }
finally {
  if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped }
  await new Promise(resolve => mock.close(resolve))
  await rm(root, { recursive: true, force: true })
}
