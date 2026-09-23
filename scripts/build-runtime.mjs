import { build } from 'esbuild'

// Bundle project TypeScript once; production indexing needs no tsx or source tree.
await build({
  entryPoints: ['scripts/index-knowledge-base.ts'],
  outfile: 'build/index-knowledge-base.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['chromadb', 'pdf-parse'],
  sourcemap: false,
  logLevel: 'info',
})

await build({
  entryPoints: ['scripts/pipeline-worker.ts'],
  outfile: 'build/pipeline-worker.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  alias: { '@': process.cwd() },
  // The Cursor SDK ships its own dynamic loader and optional runtime modules.
  // Keep the installed package intact, as the Next server already does.
  external: ['better-sqlite3', 'chromadb', 'pdf-parse', 'sharp', '@huggingface/tokenizers', '@cursor/sdk'],
  sourcemap: false,
  logLevel: 'info',
})
