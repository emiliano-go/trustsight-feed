#!/usr/bin/env node
// Squash complete old scan days into scan_daily_* and delete their raw rows.
// Idempotent: rerunning a day replaces the same rollup rows.
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... D1_DATABASE_ID=... \
//     npm run rollup:scans -- [--retention=30] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--dry-run]

const token = process.env.CLOUDFLARE_API_TOKEN || ''
const account = process.env.CLOUDFLARE_ACCOUNT_ID || ''
const database = process.env.D1_DATABASE_ID || ''
const dryRun = process.argv.includes('--dry-run')
const arg = (name, fallback) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}
const retention = Math.max(1, Number.parseInt(arg('retention', '30'), 10) || 30)
if (!token || !account || !database) {
  console.error('CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and D1_DATABASE_ID are required')
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

const dayStart = (day) => Date.parse(`${day}T00:00:00Z`) / 1000
const dayEnd = (day) => dayStart(day) + 86400

async function rollup(day) {
  const start = dayStart(day)
  const end = dayEnd(day)
  const incomplete = await query(
    'SELECT COUNT(*) AS n FROM scan_cycles WHERE substr(started_at, 1, 10) = ? AND complete = 0',
    [day],
  )
  if (Number(incomplete.results?.[0]?.n || 0) > 0) {
    console.log(`skip ${day}: incomplete cycle(s)`)
    return 0
  }
  const totals = await query(
    `SELECT COUNT(*) AS attempted,
            COALESCE(SUM(status = 'ok'), 0) AS succeeded,
            COALESCE(SUM(status = 'fetch_failed'), 0) AS fetch_failed,
            COALESCE(SUM(status = 'not_vetted'), 0) AS not_vetted,
            COALESCE(SUM(status = 'vanished'), 0) AS vanished,
            COALESCE(SUM(status = 'reserved'), 0) AS reserved,
            COALESCE(SUM(has_diff), 0) AS with_diff,
            COALESCE(SUM(score), 0) AS score_sum,
            COALESCE(SUM(score IS NOT NULL), 0) AS score_count
       FROM scan_events WHERE time >= ? AND time < ?`, [start, end],
  ).results?.[0] || {}
  const cycles = await query(
    `SELECT COUNT(*) AS cycles, COALESCE(SUM(alerts), 0) AS alerts
       FROM scan_cycles WHERE substr(started_at, 1, 10) = ?`, [day],
  ).results?.[0] || {}
  const risks = await query(
    `SELECT risk, COUNT(*) AS count FROM scan_events
      WHERE time >= ? AND time < ? GROUP BY risk`, [start, end],
  ).results || []
  const rules = await query(
    `SELECT rule_id, MAX(severity) AS severity, COUNT(*) AS count
       FROM scan_rule_events WHERE time >= ? AND time < ?
      GROUP BY rule_id`, [start, end],
  ).results || []
  const scores = await query(
    `SELECT (score / 10) * 10 AS bucket, COUNT(*) AS count FROM scan_events
      WHERE time >= ? AND time < ? AND score IS NOT NULL GROUP BY bucket`, [start, end],
  ).results || []
  const packages = await query(
    `SELECT e.package, COUNT(*) AS scans, MAX(e.score) AS max_score,
            MAX(e.has_diff) AS has_diff,
            (SELECT x.dependencies_json FROM scan_events x
              WHERE x.package = e.package AND x.time >= ? AND x.time < ?
              ORDER BY x.time DESC LIMIT 1) AS dependencies_json
       FROM scan_events e WHERE e.time >= ? AND e.time < ? GROUP BY e.package`,
    [start, end, start, end],
  ).results || []
  if (dryRun) {
    console.log(`would roll up ${day}: ${totals.attempted} scans, ${rules.length} rules`)
    return Number(totals.attempted || 0)
  }
  await query(
    `INSERT INTO scan_daily_totals
       (day, cycles, attempted, succeeded, fetch_failed, not_vetted, vanished,
        reserved, with_diff, alerts, score_sum, score_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       cycles=excluded.cycles, attempted=excluded.attempted,
       succeeded=excluded.succeeded, fetch_failed=excluded.fetch_failed,
       not_vetted=excluded.not_vetted, vanished=excluded.vanished,
       reserved=excluded.reserved, with_diff=excluded.with_diff,
       alerts=excluded.alerts, score_sum=excluded.score_sum,
       score_count=excluded.score_count`,
    [day, cycles.cycles || 0, totals.attempted || 0, totals.succeeded || 0,
      totals.fetch_failed || 0, totals.not_vetted || 0, totals.vanished || 0,
      totals.reserved || 0, totals.with_diff || 0, cycles.alerts || 0,
      totals.score_sum || 0, totals.score_count || 0],
  )
  for (const row of risks) {
    await query(`INSERT INTO scan_daily_risks (day, risk, count) VALUES (?, ?, ?)
      ON CONFLICT(day, risk) DO UPDATE SET count=excluded.count`,
    [day, row.risk || '', row.count || 0])
  }
  for (const row of rules) {
    await query(`INSERT INTO scan_daily_rules (day, rule_id, severity, count)
      VALUES (?, ?, ?, ?) ON CONFLICT(day, rule_id) DO UPDATE SET
      severity=excluded.severity, count=excluded.count`,
    [day, row.rule_id, row.severity || '', row.count || 0])
  }
  for (const row of scores) {
    await query(`INSERT INTO scan_daily_scores (day, bucket, count) VALUES (?, ?, ?)
      ON CONFLICT(day, bucket) DO UPDATE SET count=excluded.count`,
    [day, row.bucket || 0, row.count || 0])
  }
  for (const row of packages) {
    await query(`INSERT INTO scan_daily_packages
      (day, package, scans, max_score, has_diff, dependencies_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, package) DO UPDATE SET scans=excluded.scans,
      max_score=excluded.max_score, has_diff=excluded.has_diff,
      dependencies_json=excluded.dependencies_json`,
    [day, row.package, row.scans || 0, row.max_score || 0, row.has_diff || 0,
      row.dependencies_json || ''])
  }
  await query('DELETE FROM scan_rule_events WHERE time >= ? AND time < ?', [start, end])
  await query('DELETE FROM scan_events WHERE time >= ? AND time < ?', [start, end])
  console.log(`rolled up ${day}: ${totals.attempted} scans`)
  return Number(totals.attempted || 0)
}

const today = new Date()
const cutoff = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - retention * 86400000)
const to = arg('to', cutoff.toISOString().slice(0, 10))
let from = arg('from', '')
if (!from) {
  const first = await query('SELECT MIN(time) AS t FROM scan_events')
  const stamp = Number(first.results?.[0]?.t || 0)
  from = stamp ? new Date(stamp * 1000).toISOString().slice(0, 10) : to
}
let cursor = new Date(`${from}T00:00:00Z`)
const end = new Date(`${to}T00:00:00Z`)
let total = 0
while (cursor <= end) {
  const day = cursor.toISOString().slice(0, 10)
  total += await rollup(day)
  cursor = new Date(cursor.getTime() + 86400000)
}
console.log(`${dryRun ? 'dry-run: ' : ''}${total} scan record(s) squashed through ${to}`)
