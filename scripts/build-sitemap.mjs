// Regenerates public/sitemap.xml from the deployed feed API, so every alert
// and heartbeat detail page is listed. Run: node scripts/build-sitemap.mjs
import { writeFile } from 'node:fs/promises'

const SITE = (process.env.SITE_URL || 'https://watcher.trustsight.org').replace(/\/+$/, '')
const API = (process.env.API_URL || `${SITE}/api`).replace(/\/+$/, '')
const OUT = new URL('../public/sitemap.xml', import.meta.url)

// The feed is newest-first and cursor-paged; walk `next` until it runs out.
async function allItems() {
  const items = []
  let cursor = null
  for (;;) {
    const url = new URL(`${API}/feed`)
    url.searchParams.set('event', 'all')
    url.searchParams.set('limit', '200')
    if (cursor) {
      url.searchParams.set('before', cursor.before)
      url.searchParams.set('beforeRow', cursor.beforeRow)
    }
    const res = await fetch(url, { headers: { 'user-agent': 'trustsight-feed-sitemap/1.0' } })
    if (!res.ok) throw new Error(`feed request failed: ${res.status}`)
    const body = await res.json()
    items.push(...(body.items || []))
    if (!body.next) break
    cursor = body.next
  }
  return items
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const items = await allItems()
const urls = [
  { loc: `${SITE}/`, lastmod: items[0]?.iso },
  { loc: `${SITE}/api/` },
  ...items.map((i) => ({ loc: `${SITE}/${i.slug}/`, lastmod: i.iso })),
]

const xml =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls
    .map(({ loc, lastmod }) =>
      `  <url>\n    <loc>${esc(loc)}</loc>${lastmod ? `\n    <lastmod>${lastmod.slice(0, 10)}</lastmod>` : ''}\n  </url>`
    )
    .join('\n') +
  '\n</urlset>\n'

await writeFile(OUT, xml)
console.log(`sitemap: wrote ${urls.length} urls to public/sitemap.xml`)
