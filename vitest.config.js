import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config'

const here = path.dirname(fileURLToPath(import.meta.url))

// The cross-surface contract core emits (`contract/contract.json`).  Resolved
// the same way `scripts/build_rule_catalog.py` finds core: `TRUSTSIGHT_SRC`
// points at its `src/`, else the sibling checkout.  Read here, in Node, and
// handed to the worker as a binding - `fs` does not exist inside workerd.
function resolveContract() {
  const explicit = process.env.TRUSTSIGHT_CONTRACT
  if (explicit) return explicit
  const src = process.env.TRUSTSIGHT_SRC
  if (src) return path.resolve(src, '..', 'contract', 'contract.json')
  return path.resolve(here, '..', 'trustsight', 'contract', 'contract.json')
}

function readContract() {
  const file = resolveContract()
  if (!existsSync(file)) {
    console.warn(`contract artifact not found at ${file}; contract tests will skip`)
    return null
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}

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
            bindings: {
              TEST_MIGRATIONS: migrations,
              TEST_CONTRACT: readContract(),
            },
          },
        },
      },
    },
  }
})
