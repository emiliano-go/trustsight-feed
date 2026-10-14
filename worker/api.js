// Read API over the D1 store. The frontend is same-origin, so no CORS.

import { ftsQuery, summarize } from './lib.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=30',
    },
  })
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

async function feed(env, url) {
  const q = url.searchParams.get('q')
  const event = url.searchParams.get('event') || 'trustsight.alerts'
  const day = url.searchParams.get('day')
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  const beforeTime = url.searchParams.get('before')
  const beforeRow = url.searchParams.get('beforeRow')
  const limit = clampInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT)

  const fts = ftsQuery(q)
  const where = []
  const params = []

  if (fts) {
    where.push('f.notifications_fts MATCH ?')
    params.push(fts)
  }
  if (event !== 'all') {
    where.push('n.event = ?')
    params.push(event)
  }
  if (day) { where.push('n.day = ?'); params.push(day) }
  if (from) { where.push('n.time >= ?'); params.push(Number(from)) }
  if (to) { where.push('n.time <= ?'); params.push(Number(to)) }
  if (beforeTime && beforeRow) {
    where.push('(n.time < ? OR (n.time = ? AND n.rowid < ?))')
    params.push(Number(beforeTime), Number(beforeTime), Number(beforeRow))
  }

  const fromClause = fts
    ? 'notifications n JOIN notifications_fts f ON f.rowid = n.rowid'
    : 'notifications n'
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const { results } = await env.DB.prepare(
    `SELECT n.*, n.rowid AS _rowid FROM ${fromClause} ${whereClause} ORDER BY n.time DESC, n.rowid DESC LIMIT ?`
  )
    .bind(...params, limit)
    .all()

  const items = (results || []).map(summarize)
  const last = results && results.length === limit ? results[results.length - 1] : null
  return json({
    items,
    next: last ? { before: last.time, beforeRow: last._rowid } : null,
  })
}

async function message(env, slug) {
  const row = await env.DB.prepare('SELECT * FROM notifications WHERE slug = ?')
    .bind(slug)
    .first()
  if (!row) return json({ error: 'not_found' }, 404)
  let payload = {}
  try { payload = JSON.parse(row.payload || '{}') } catch { /* keep {} */ }
  return json({
    ...summarize(row),
    payload,
    message_raw: row.message_raw,
  })
}

async function stats(env) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            MIN(time) AS first,
            MAX(time) AS last,
            COALESCE(SUM(n_alerts), 0) AS alerts,
            COALESCE(SUM(n_over_threshold), 0) AS over_threshold,
            COALESCE(SUM(n_ioc), 0) AS ioc,
            COALESCE(SUM(n_impersonation), 0) AS impersonation
       FROM notifications
      WHERE event = 'trustsight.alerts'`
  ).first()
  return json(row || {})
}

/** Dispatch an API request, or return null when the path is not ours. */
export async function handleApi(request, env, url) {
  const path = url.pathname
  if (path === '/api/feed') return feed(env, url)
  if (path === '/api/stats') return stats(env)
  if (path.startsWith('/api/messages/')) {
    const slug = decodeURIComponent(path.slice('/api/messages/'.length))
    if (!slug) return json({ error: 'not_found' }, 404)
    return message(env, slug)
  }
  return null
}
