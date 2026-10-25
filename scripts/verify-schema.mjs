#!/usr/bin/env node
// The Worker fails closed on a schema mismatch.  This check makes sure the
// migration that sets meta.schema agrees with worker/schema.js, so a future
// migration cannot forget the bump.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPECTED_SCHEMA } from '../worker/schema.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrations = path.join(here, '..', 'migrations')
const files = (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()
let declared = ''
for (const file of files) {
  const text = await readFile(path.join(migrations, file), 'utf8')
  const match = text.match(/UPDATE\s+meta\s+SET\s+value\s*=\s*'([^']+)'\s+WHERE\s+key\s*=\s*'schema'/i)
  if (match) declared = match[1]
}
if (declared !== EXPECTED_SCHEMA) {
  console.error(`schema mismatch: migrations declare ${declared || '(none)'}, worker expects ${EXPECTED_SCHEMA}`)
  process.exit(1)
}
console.log(`schema ${EXPECTED_SCHEMA} matches the latest migration`)
