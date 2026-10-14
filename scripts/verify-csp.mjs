// Verify the inline theme bootstrap in index.html is the one pinned in
// public/_headers. The site's CSP has no 'unsafe-inline', so a drift between
// the two would silently block the pre-paint theme script.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const indexPath = new URL('../index.html', import.meta.url)
const headersPath = new URL('../public/_headers', import.meta.url)

const html = await readFile(indexPath, 'utf8')
const headers = await readFile(headersPath, 'utf8')

const match = html.match(/<script>([\s\S]*?)<\/script>/)
if (!match) {
  console.error('verify-csp: no inline <script> found in index.html')
  process.exit(1)
}

const hash = `sha256-${createHash('sha256').update(match[1]).digest('base64')}`
if (!headers.includes(`'${hash}'`)) {
  console.error('verify-csp: public/_headers CSP does not pin the current theme script hash.')
  console.error(`  expected to find: '${hash}'`)
  console.error('  update the script-src in public/_headers')
  process.exit(1)
}

console.log(`verify-csp: theme bootstrap hash pinned (${hash})`)
