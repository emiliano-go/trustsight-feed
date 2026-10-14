import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config'

// Worker tests run inside workerd via Miniflare, with a local D1. The real
// migrations are read at config time and handed to the tests through a
// binding, so the schema under test is the schema that ships.
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations('./migrations')
  return {
    test: {
      setupFiles: ['./test/setup.js'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './test/wrangler.jsonc' },
          miniflare: {
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  }
})
