#!/usr/bin/env node
// Backfill the derived campaign/maintainer/IOC indexes for notifications that
// were stored before those indexes existed.  Idempotent; safe to re-run.
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... D1_DATABASE_ID=... \
//     npm run backfill:events -- --require-complete
//
// The script uses the same buildEventIndex() as ingest, so the two paths cannot
// drift.  It pages notifications by rowid and writes only INSERT OR IGNORE
// rows; the notification table is never changed.

import { buildEventIndex } from '../worker/lib.js'

const token = process.env.CLOUDFLARE_API_TOKEN || ''
const account = process.env.CLOUDFLARE_ACCOUNT_ID || ''
const database = process.env.D1_DATABASE_ID || ''
const dryRun = process.argv.includes('--dry-run')
const requireComplete = process.argv.includes('--require-complete')
const all = process.argv.includes('--all')
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='))
const limit = limitArg ? Math.max(1, Number.parseInt(limitArg.split('=')[1], 10) || 1) : Infinity

if (!token || !account || !database) {
  console.error('CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and D1_DATABASE_ID are required')
  process.exit(2)
}

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`

async function query(sql, params = []) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.success === false) {
    throw new Error(`D1 query failed (${res.status}): ${body.errors ? JSON.stringify(body.errors) : 'unknown'}`)
  }
  const first = Array.isArray(body.result) ? body.result[0] : body.result
  return first || {}
}

function insertSql(table, columns, rows) {
  if (!rows.length) return null
  const placeholders = rows.map(() => `(${columns.map(() => '?').join(',')})`).join(',')
  const params = rows.flatMap((row) => columns.map((column) => row[column]))
  return {
    sql: `INSERT OR IGNORE INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`,
    params,
  }
}

const CAMPAIGN_COLUMNS = ['campaign_id', 'rule_id', 'package', 'time', 'slug',
  'maintainer', 'previous_maintainer', 'version', 'legacy']
const MAINTAINER_COLUMNS = ['maintainer_key', 'maintainer', 'package',
  'previous_maintainer', 'rule_id', 'time', 'slug']
const IOC_COLUMNS = ['indicator', 'package', 'time', 'slug']
const RULE_COLUMNS = ['package', 'rule_id', 'severity', 'weight', 'file', 'line',
  'reason', 'source', 'campaign_id', 'time', 'slug']
// Bump when a new derived table is added: the old rowid marker would skip
// notifications that predate the table.
const INDEX_VERSION = '2'

async function flush(events) {
  if (dryRun) return
  const chunks = []
  const push = (table, columns, rows) => {
    // D1 accepts at most 100 bound parameters per query.  Size each batch
    // for its table: 11 campaign rows, 14 maintainer rows, or 25 IOC rows.
    const batchSize = Math.max(1, Math.floor(100 / columns.length))
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize)
      const statement = insertSql(table, columns, batch)
      if (statement) chunks.push(statement)
    }
  }
  push('campaign_events', CAMPAIGN_COLUMNS, events.campaigns)
  push('maintainer_events', MAINTAINER_COLUMNS, events.maintainers)
  push('ioc_events', IOC_COLUMNS, events.iocs)
  push('rule_events', RULE_COLUMNS, events.rules)
  for (const statement of chunks) await query(statement.sql, statement.params)
}

const pageSize = 200
let lastRowid = 0
if (!all) {
  const marker = await query("SELECT value FROM meta WHERE key = 'events_backfill_through_rowid'")
  const version = await query("SELECT value FROM meta WHERE key = 'events_index_version'")
  lastRowid = String(version.results?.[0]?.value || '') === INDEX_VERSION
    ? Number(marker.results?.[0]?.value || 0)
    : 0
}
let processed = 0
const snapshot = await query('SELECT MAX(rowid) AS max_rowid FROM notifications')
const maxRowid = Number(snapshot.results?.[0]?.max_rowid || 0)

while (processed < limit) {
  const page = await query(
    'SELECT rowid, slug, time, payload FROM notifications WHERE rowid > ? ORDER BY rowid ASC LIMIT ?',
    [lastRowid, Math.min(pageSize, limit - processed)],
  )
  const rows = page.results || []
  if (!rows.length) break
  const events = { campaigns: [], maintainers: [], iocs: [], rules: [] }
  for (const row of rows) {
    let payload = {}
    try { payload = JSON.parse(row.payload || '{}') } catch { continue }
    const index = buildEventIndex(payload)
    const stamp = { time: row.time, slug: row.slug }
    for (const event of index.campaigns) events.campaigns.push({ ...event, ...stamp })
    for (const event of index.maintainers) events.maintainers.push({ ...event, ...stamp })
    for (const event of index.iocs) events.iocs.push({ ...event, ...stamp })
    for (const event of index.rules) events.rules.push({ ...event, ...stamp })
  }
  await flush(events)
  lastRowid = Number(rows[rows.length - 1].rowid)
  processed += rows.length
  console.log(`backfill: ${processed} notifications, through rowid ${lastRowid}`)
}

if (dryRun) {
  console.log(`dry-run: would process ${processed} notifications (snapshot max ${maxRowid})`)
  process.exit(0)
}

await query(
  `INSERT INTO meta (key, value) VALUES ('events_backfill_complete', '1')
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
)
await query(
  `INSERT INTO meta (key, value) VALUES ('events_backfill_through_rowid', ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  [String(lastRowid)],
)
await query(
  `INSERT INTO meta (key, value) VALUES ('events_backfill_at', ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  [String(Math.floor(Date.now() / 1000))],
)
await query(
  `INSERT INTO meta (key, value) VALUES ('events_index_version', ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  [INDEX_VERSION],
)

if (requireComplete && lastRowid < maxRowid) {
  console.error(`backfill incomplete: processed through ${lastRowid}, snapshot max ${maxRowid}`)
  process.exit(1)
}
console.log(`backfill complete: ${processed} notifications through rowid ${lastRowid}`)
