// Ingestion: poll the ntfy JSON API and persist every notification to D1.
//
// The poll is incremental: `since=<cursor>` returns only messages newer than
// the last one stored, so a cycle costs one small request. Failures are always
// swallowed - a notification pipeline must never wedge the cursor.

import { isTrustSightNotification, parseNotification } from './lib.js'

const CURSOR_KEY = 'cursor'

async function getCursor(env) {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?')
    .bind(CURSOR_KEY)
    .first()
  return (row && row.value) || ''
}

async function setCursor(env, value) {
  await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(CURSOR_KEY, value)
    .run()
}

/** Resolve the slug to store, appending the ntfy id on a same-second clash. */
async function resolveSlug(env, base, id) {
  const clash = await env.DB.prepare('SELECT id FROM notifications WHERE slug = ?')
    .bind(base)
    .first()
  if (clash && clash.id !== id) return `${base}-${id}`
  return base
}

async function storeNotification(env, msg) {
  const row = parseNotification(msg)
  if (!row.id) return false
  // The topic is public; only store documents the watcher marks as its own.
  if (!isTrustSightNotification(row)) return false

  const existing = await env.DB.prepare('SELECT id FROM notifications WHERE id = ?')
    .bind(row.id)
    .first()
  if (existing) return false

  const slug = await resolveSlug(env, row.slug, row.id)
  await env.DB.prepare(
    `INSERT INTO notifications
       (id, time, event, topic, title, priority, tags, day, slug, message_raw,
        payload, n_alerts, n_over_threshold, n_ioc, n_impersonation, search_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.id, row.time, row.event, row.topic, row.title, row.priority, row.tags,
      row.day, slug, row.message_raw, row.payload, row.n_alerts,
      row.n_over_threshold, row.n_ioc, row.n_impersonation, row.search_text,
      Math.floor(Date.now() / 1000)
    )
    .run()
  return true
}

function ntfyUrl(env, since) {
  const server = String(env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '')
  const topic = encodeURIComponent(env.NTFY_TOPIC || '')
  return `${server}/${topic}/json?poll=1&since=${encodeURIComponent(since || 'all')}`
}

/**
 * One ingestion cycle. Returns { received, stored, cursor, truncated }.
 * Never throws for a downstream problem; a caller logging the result is enough.
 */
export async function pollNtfy(env) {
  const cursor = await getCursor(env)
  const headers = { accept: 'application/x-ndjson' }
  if (env.NTFY_TOKEN) headers.authorization = `Bearer ${env.NTFY_TOKEN}`

  let response
  try {
    response = await fetch(ntfyUrl(env, cursor), { headers })
  } catch (err) {
    console.warn('ntfy fetch failed:', err)
    return { received: 0, stored: 0, cursor, error: 'fetch' }
  }

  if (response.status === 429) {
    console.warn('ntfy rate limited (429); skipping cycle')
    return { received: 0, stored: 0, cursor, error: 'rate_limited' }
  }
  if (!response.ok) {
    console.warn('ntfy returned', response.status)
    return { received: 0, stored: 0, cursor, error: `http_${response.status}` }
  }

  const truncated = response.headers.get('X-Messages-Truncated') === '1'
  const text = await response.text()

  let received = 0
  let stored = 0
  let lastId = ''
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (msg.event !== 'message' || !msg.id) continue
    received += 1
    lastId = msg.id
    try {
      if (await storeNotification(env, msg)) stored += 1
    } catch (err) {
      console.warn('store failed for', msg.id, err)
    }
  }

  if (lastId && lastId !== cursor) await setCursor(env, lastId)
  return { received, stored, cursor: lastId || cursor, truncated }
}
