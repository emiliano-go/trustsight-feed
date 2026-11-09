#!/usr/bin/env node
// Import compact `trustsight.scans` NDJSON into D1.  The exporter lives in the
// TrustSight checkout (`trustsight full-aur export-scans`).  Idempotent on
// (cycle_id, chunk_index) and (cycle_id, package); safe to resume.
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... D1_DATABASE_ID=... \
//     npm run import:scans -- scans.ndjson [--dry-run] [--require-complete]

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { normalizeScanDocument } from '../worker/scans.js'

const token = process.env.CLOUDFLARE_API_TOKEN || ''
const account = process.env.CLOUDFLARE_ACCOUNT_ID || ''
const database = process.env.D1_DATABASE_ID || ''
const file = process.argv[2]
const dryRun = process.argv.includes('--dry-run')
const requireComplete = process.argv.includes('--require-complete')
if (!token || !account || !database || !file) {
  console.error('CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID and an NDJSON path are required')
  process.exit(2)
}

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`

async function query(sql, params = []) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.success === false) {
    throw new Error(`D1 query failed (${res.status}): ${body.errors ? JSON.stringify(body.errors) : 'unknown'}`)
  }
  const first = Array.isArray(body.result) ? body.result[0] : body.result
  return first || {}
}

function values(rows, columns) {
  return rows.map(() => `(${columns.map(() => '?').join(',')})`).join(',')
}

async function insertMany(table, columns, rows) {
  if (!rows.length) return
  const size = Math.max(1, Math.floor(100 / columns.length))
  for (let i = 0; i < rows.length; i += size) {
    const batch = rows.slice(i, i + size)
    await query(
      `INSERT OR IGNORE INTO ${table} (${columns.join(',')}) VALUES ${values(batch, columns)}`,
      batch.flatMap((row) => columns.map((column) => row[column])),
    )
  }
}

const CYCLE_COLUMNS = ['cycle_id', 'started_at', 'finished_at', 'received_at',
  'tool_version', 'partial', 'bootstrap', 'backfill_day', 'chunk_count',
  'attempted', 'succeeded', 'fetch_failed', 'not_vetted', 'vanished', 'reserved',
  'with_diff', 'alerts']
const CHUNK_COLUMNS = ['cycle_id', 'chunk_index', 'received_at']
const EVENT_COLUMNS = ['cycle_id', 'package', 'status', 'score', 'risk',
  'old_version', 'new_version', 'maintainer', 'rules_json',
  'coverage_gaps_json', 'has_diff', 'time']
const RULE_COLUMNS = ['cycle_id', 'package', 'rule_id', 'severity', 'time']

let imported = 0
let chunks = 0
const seen = new Set()
const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
for await (const line of reader) {
  if (!line.trim()) continue
  const payload = JSON.parse(line)
  const normalized = normalizeScanDocument(payload)
  const { cycle, records, rules, chunkIndex } = normalized
  const cycleKey = `${cycle.cycle_id}:${chunkIndex}`
  if (seen.has(cycleKey)) continue
  seen.add(cycleKey)
  if (!dryRun) {
    await insertMany('scan_cycles', CYCLE_COLUMNS, [cycle])
    await insertMany('scan_cycle_chunks', CHUNK_COLUMNS, [{
      cycle_id: cycle.cycle_id, chunk_index: chunkIndex, received_at: cycle.received_at,
    }])
    await insertMany('scan_events', EVENT_COLUMNS, records)
    await insertMany('scan_rule_events', RULE_COLUMNS, rules)
    await query(
      `UPDATE scan_cycles SET
         chunks_received = (SELECT COUNT(*) FROM scan_cycle_chunks WHERE cycle_id = ?),
         complete = (SELECT COUNT(*) FROM scan_cycle_chunks WHERE cycle_id = ?) >= chunk_count
       WHERE cycle_id = ?`,
      [cycle.cycle_id, cycle.cycle_id, cycle.cycle_id],
    )
  }
  imported += records.length
  chunks += 1
  if (chunks % 50 === 0) console.log(`import-scans: ${chunks} chunks, ${imported} records`)
}

if (requireComplete && !dryRun) {
  const row = await query('SELECT COUNT(*) AS n FROM scan_cycles WHERE complete = 0')
  const incomplete = Number(row.results?.[0]?.n || 0)
  if (incomplete) {
    console.error(`import-scans incomplete: ${incomplete} cycle(s) missing chunks`)
    process.exit(1)
  }
}
console.log(`${dryRun ? 'dry-run: ' : ''}${chunks} chunk(s), ${imported} scan record(s)`)
