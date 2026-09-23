import { defineConfig, type Config } from 'drizzle-kit'

export default defineConfig({
  schema: './lib/db/schema.sqlite.ts',
  out: './drizzle/sqlite',
  dialect: 'sqlite',
  dbCredentials: { url: process.env.SQLITE_DATABASE_PATH ?? './.drizzle-local-check.db' },
  verbose: true,
  strict: true,
}) satisfies Config
