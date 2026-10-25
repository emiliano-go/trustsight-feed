#!/usr/bin/env node
// Parse every worker/script module with node --check.  This catches syntax
// errors in code paths the Vite build does not transform (worker/, scripts/).

import { execFileSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const files = []

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full)
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(full)
  }
}

await walk(path.join(root, 'worker'))
await walk(path.join(root, 'scripts'))
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (err) {
    console.error(`syntax error: ${path.relative(root, file)}`)
    process.stderr.write(err.stderr || err.message)
    process.exit(1)
  }
}
console.log(`syntax ok: ${files.length} modules`)
