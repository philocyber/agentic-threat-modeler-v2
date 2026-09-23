import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', quiet: true });
loadEnv({ path: '.env', quiet: true });
import { Config, defineConfig } from 'drizzle-kit';

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL

  const host = process.env.DB_HOST ?? 'localhost'
  const port = process.env.DB_PORT ?? '5432'
  const name = process.env.DB_NAME ?? 'agentic-tm'
  const user = process.env.DB_USER ?? 'postgres'
  const password = process.env.DB_PASSWORD ?? 'password'

  return `postgresql://${user}:${password}@${host}:${port}/${name}`
}

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl(),
  },
  verbose: true,
  strict: true,
}) satisfies Config;
