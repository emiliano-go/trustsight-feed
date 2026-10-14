// Post-build polish, mirroring trustsight.web: inline the single stylesheet
// so nothing render-blocks, pin its hash in the CSP (the site has no
// 'unsafe-inline'), and drop the now-dead CSS asset.
//
// Runs after `vite build`, against dist/ only.

import { createHash } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'

const dist = new URL('../dist/', import.meta.url)
const indexPath = new URL('index.html', dist)
const headersPath = new URL('_headers', dist)

let html = await readFile(indexPath, 'utf8')

const linkMatch = html.match(/<link[^>]*rel="stylesheet"[^>]*>/)
if (!linkMatch) throw new Error('optimize: no stylesheet link in dist/index.html')

const hrefMatch = linkMatch[0].match(/href="([^"]+)"/)
if (!hrefMatch) throw new Error('optimize: stylesheet link has no href')

const cssPath = new URL(`.${hrefMatch[1]}`, dist)
const css = await readFile(cssPath, 'utf8')

html = html.replace(linkMatch[0], `<style>${css}</style>`)
await writeFile(indexPath, html)

const hash = `'sha256-${createHash('sha256').update(css).digest('base64')}'`
const headers = await readFile(headersPath, 'utf8')
const updated = headers.replace(/style-src 'self'(?: '[^']+')*/, `style-src 'self' ${hash}`)
if (updated === headers) {
  throw new Error("optimize: could not pin the inline style hash (style-src 'self' not found in dist/_headers)")
}
await writeFile(headersPath, updated)

await rm(cssPath, { force: true })

console.log(`optimize: inlined ${(Buffer.byteLength(css) / 1024).toFixed(1)} KiB CSS and pinned ${hash}`)
