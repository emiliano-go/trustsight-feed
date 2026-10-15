// Ingestion: poll the ntfy JSON API and persist every notification to D1.
//
// The poll is incremental: `since=<cursor>` returns only messages newer than
// the last one stored, so a cycle costs one small request.  A message that
// fails to store holds the cursor so it is retried, but only up to a bound;
// after that it is dropped with a log, so one un-fetchable notification can
// never wedge the feed.

import { attachmentUrl, isTrustSightNotification, parseNotification, resolveDocumentBody } from './lib.js'

const CURSOR_KEY = 'cursor'

function serverHost(env) {
  try { return new URL(env.NTFY_SERVER || 'https://ntfy.sh').host } catch { return 'ntfy.sh' }
}

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

// The message a store keeps failing on, with how many cycles it has failed,
// as "<id>:<attempts>". A poll holds the cursor so the message is retried, but
// only up to a bound: one un-fetchable attachment must not hold the whole feed.
const RETRY_KEY = 'retry'
const MAX_RETRY_ATTEMPTS = 6

async function bumpRetry(env, id) {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?')
    .bind(RETRY_KEY)
    .first()
  const [prevId, prevN] = ((row && row.value) || '').split(':')
  const attempts = (prevId === id ? Number(prevN) || 0 : 0) + 1
  await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(RETRY_KEY, `${id}:${attempts}`)
    .run()
  return attempts
}

async function clearRetry(env) {
  await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(RETRY_KEY, '')
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

async function storeNotification(env, msg, host, headers) {
  // A document over ntfy's message-body limit is delivered as an attachment;
  // resolve it before parsing so a large document is not dropped.
  const attach = attachmentUrl(msg, host)
  const document = await resolveDocumentBody(msg, host,
    (url, opts) => fetch(url, { ...(opts || {}), headers }))
  const row = parseNotification({ ...msg, message: document })
  if (!row.id) return false
  // The topic is public; only store documents the watcher marks as its own.
  if (!isTrustSightNotification(row)) {
    console.warn('rejected', row.id, 'tool', JSON.stringify(row.tool), 'event', row.event, 'attach', attach || '')
    return false
  }

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
 * One GET, retried once on a network error or a 5xx. ntfy.sh occasionally
 * answers 522 (an edge timeout) under load; a retry usually clears it, and a
 * miss is harmless because ntfy caches the message for the next cycle.
 */
const POLL_TIMEOUT_MS = 8_000
const POLL_ATTEMPTS = 3

async function fetchNtfy(url, headers) {
  let last
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS)
      try {
        last = await fetch(url, { headers, signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      if (last.status < 500) return last
    } catch {
      last = undefined
    }
  }
  if (last) return last
  throw new Error('ntfy poll failed after retries')
}

/**
 * One ingestion cycle. Returns { received, stored, cursor, truncated }.
 * Never throws for a downstream problem; a caller logging the result is enough.
 */
export async function pollNtfy(env) {
  const cursor = await getCursor(env)
  const headers = {
    accept: 'application/x-ndjson',
    // Some ntfy edge nodes 522 a request with no user agent.
    'user-agent': 'trustsight-feed/0.1 (+https://watcher.trustsight.org)',
  }
  if (env.NTFY_TOKEN) headers.authorization = `Bearer ${env.NTFY_TOKEN}`
  const host = serverHost(env)

  let response
  try {
    response = await fetchNtfy(ntfyUrl(env, cursor), headers)
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
  // The cursor moves to a message once it is *handled* - stored, skipped as a
  // duplicate, or rejected as not-ours.  A message whose store threw (a
  // transient fetch or D1 error) holds the cursor so the next poll retries it:
  // ntfy's `since=<id>` walks publication order, so advancing past it would
  // drop the notification forever.  But the hold is bounded - after
  // MAX_RETRY_ATTEMPTS the message is dropped with a log and the cursor moves
  // on, so one un-fetchable attachment cannot wedge the whole feed (it did:
  // a hung fetch held ingestion for hours).
  let committed = ''
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
    try {
      if (await storeNotification(env, msg, host, headers)) stored += 1
      committed = msg.id
      await clearRetry(env)
    } catch (err) {
      const attempts = await bumpRetry(env, msg.id)
      if (attempts >= MAX_RETRY_ATTEMPTS) {
        console.warn('dropping', msg.id, 'after', attempts, 'failed attempts:', err)
        committed = msg.id
        await clearRetry(env)
        continue
      }
      console.warn('store failed for', msg.id, `(attempt ${attempts}/${MAX_RETRY_ATTEMPTS}) - holding the cursor to retry:`, err)
      break
    }
  }

  if (committed && committed !== cursor) await setCursor(env, committed)
  return { received, stored, cursor: committed || cursor, truncated }
}
