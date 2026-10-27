// The one write path: both ingestion routes (the signed direct POST and, for
// parity, an ntfy-shaped message) funnel through `storeRow`, so a document
// stored one way is byte-identical to the same document stored the other.

import { buildEventIndex, isTrustSightNotification, parseNotification } from './lib.js'

const MAX_BATCH_STATEMENTS = 100

async function insertRow(env, row, slug, verification = null) {
  let payload = {}
  try { payload = JSON.parse(row.payload || '{}') } catch { /* keep {} */ }
  const events = buildEventIndex(payload)
  const statements = [
    env.DB.prepare(
      `INSERT INTO notifications
         (id, time, event, topic, title, priority, tags, day, slug, message_raw,
          payload, n_alerts, n_over_threshold, n_ioc, n_impersonation, search_text,
          created_at, webhook_id, key_id, signed_at, signature, body_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(
      row.id, row.time, row.event, row.topic, row.title, row.priority, row.tags,
      row.day, slug, row.message_raw, row.payload, row.n_alerts,
      row.n_over_threshold, row.n_ioc, row.n_impersonation, row.search_text,
      Math.floor(Date.now() / 1000),
      verification ? verification.webhookId : null,
      verification ? verification.keyId : null,
      verification ? verification.signedAt : null,
      verification ? verification.signature : null,
      verification ? verification.bodySha256 : null
    ),
  ]
  for (const event of events.campaigns) {
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO campaign_events
         (campaign_id, rule_id, package, time, slug, maintainer,
          previous_maintainer, version, legacy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(event.campaign_id, event.rule_id, event.package, row.time, slug,
      event.maintainer, event.previous_maintainer, event.version, event.legacy))
  }
  for (const event of events.maintainers) {
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO maintainer_events
         (maintainer_key, maintainer, package, previous_maintainer, rule_id, time, slug)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(event.maintainer_key, event.maintainer, event.package,
      event.previous_maintainer, event.rule_id, row.time, slug))
  }
  for (const event of events.iocs) {
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO ioc_events (indicator, package, time, slug)
       VALUES (?, ?, ?, ?)`
    ).bind(event.indicator, event.package, row.time, slug))
  }
  for (const event of events.rules) {
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO rule_events
         (package, rule_id, severity, weight, file, line, reason, source,
          campaign_id, time, slug)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(event.package, event.rule_id, event.severity, event.weight,
      event.file, event.line, event.reason, event.source, event.campaign_id,
      row.time, slug))
  }
  if (statements.length <= MAX_BATCH_STATEMENTS) {
    await env.DB.batch(statements)
    return
  }
  // A hostile document can name many members.  Keep the notification as the
  // source of truth and write the derived index in bounded chunks; a failed
  // event chunk leaves the notification readable through the API fallbacks.
  await env.DB.batch(statements.slice(0, 1))
  for (let i = 1; i < statements.length; i += MAX_BATCH_STATEMENTS) {
    await env.DB.batch(statements.slice(i, i + MAX_BATCH_STATEMENTS))
  }
}

/**
 * Persist one parsed row. Returns true when a new row was written, false when
 * the row is not ours or already present (idempotent on the row id, which is
 * the natural dedupe key for both sources).
 */
export async function storeRow(env, row, verification = null) {
  if (!row.id) return false
  // The feed is public; only store documents the watcher marks as its own.
  if (!isTrustSightNotification(row)) return false

  // One read covers the id, the same-second slug and a replayed body.  The
  // unique body hash also closes the race in the database.
  const { results } = await env.DB.prepare(
    'SELECT id, slug, body_sha256 FROM notifications WHERE id = ? OR slug = ? OR (body_sha256 IS NOT NULL AND body_sha256 = ?) LIMIT 3'
  ).bind(row.id, row.slug, verification ? verification.bodySha256 : null).all()
  const hits = results || []
  if (hits.some((hit) => hit.id === row.id)) return false
  // Heartbeats are deliberately identical across quiet cycles: the payload
  // carries only cycle counts.  De-duplicating them by body hash would drop a
  // real liveness signal, so the replay guard applies to content documents
  // only; a heartbeat is still unique by its webhook id and timestamp.
  const heartbeat = row.event === 'trustsight.heartbeat'
  if (!heartbeat && verification && hits.some(
    (hit) => hit.body_sha256 && hit.body_sha256 === verification.bodySha256)) {
    // A captured signed body replayed under a new webhook id is not a new
    // notification.  The unique index is the final guard against the race.
    return false
  }
  const slugTaken = hits.some((hit) => hit.slug === row.slug)
  const slug = slugTaken ? `${row.slug}-${row.id}` : row.slug

  const stored = heartbeat && verification
    ? { ...verification, bodySha256: null }
    : verification
  try {
    await insertRow(env, row, slug, stored)
  } catch (err) {
    const message = String(err && err.message)
    if (/UNIQUE constraint failed: notifications\.body_sha256/.test(message)) {
      return false
    }
    // A concurrent same-second writer took the slug between read and insert.
    if (!/UNIQUE constraint failed: notifications\.slug/.test(message)) throw err
    await insertRow(env, row, `${row.slug}-${row.id}`, stored)
  }
  return true
}

/**
 * Parse an ntfy-shaped message into a row (the historical route, kept so the
 * parity test can prove the two routes agree). `msg.message` is the document.
 */
export function rowFromNtfyMessage(msg) {
  return parseNotification(msg)
}
