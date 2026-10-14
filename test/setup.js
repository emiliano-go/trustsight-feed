import { applyD1Migrations, env } from 'cloudflare:test'

// Runs once before the suite: build the D1 schema from the shipped migrations.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
