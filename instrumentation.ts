export async function register() {
  // The Node-only work (config validation, crash recovery) pulls in native
  // modules such as better-sqlite3. Importing it inside this guard keeps it out
  // of the Edge bundle, which has no `fs`.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNodeRuntime } = await import('./instrumentation-node')
    await registerNodeRuntime()
  }
}
