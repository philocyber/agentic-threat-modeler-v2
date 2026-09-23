import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const connectionString = process.env.DATABASE_URL!

// In Next.js, prevent multiple connections during hot reload
declare global {
   
  var _pgClient: postgres.Sql | undefined
}

const client = global._pgClient ?? postgres(connectionString, { max: 10 })

if (process.env.NODE_ENV !== 'production') {
  global._pgClient = client
}

export const db = drizzle(client, { schema })

