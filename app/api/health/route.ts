import { sql } from 'drizzle-orm'

/**
 * Unauthenticated liveness probe — DB connectivity only.
 * Deep dependency checks: GET /api/v1/health.
 *
 * Local workspace mode (no DATABASE_URL) has no Postgres to probe — the
 * Dockerfile HEALTHCHECK still needs a 200, so report ok with mode 'local'.
 */
export async function GET() {
  if (!process.env.DATABASE_URL) {
    return Response.json({ status: 'ok' })
  }

  try {
    // Dynamic import: without DATABASE_URL, lib/db would build a Postgres
    // client pointing at defaults (localhost) and every query would fail.
    const { db } = await import('@/lib/db')
    await db.execute(sql`SELECT 1`)
    return Response.json({ status: 'ok' })
  } catch {
    return Response.json(
      { status: 'error' },
      { status: 503 }
    )
  }
}
