// The one write path: both ingestion routes (the signed direct POST and, for
// parity, an ntfy-shaped message) funnel through `storeRow`, so a document
// stored one way is byte-identical to the same document stored the other.

import { isTrustSightNotification, parseNotification } from './lib.js'

async function insertRow(env, row, slug) {
  await env.DB.prepare(
    `INSERT INTO notifications
       (id, time, event, topic, title, priority, tags, day, slug, message_raw,
        payload, n_alerts, n_over_threshold, n_ioc, n_impersonation, search_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  )
    .bind(
      row.id, row.time, row.event, row.topic, row.title, row.priority, row.tags,
      row.day, slug, row.message_raw, row.payload, row.n_alerts,
      row.n_over_threshold, row.n_ioc, row.n_impersonation, row.search_text,
      Math.floor(Date.now() / 1000)
    )
    .run()
}

/**
 * Persist one parsed row. Returns true when a new row was written, false when
 * the row is not ours or already present (idempotent on the row id, which is
 * the natural dedupe key for both sources).
 */
export async function storeRow(env, row) {
  if (!row.id) return false
  // The feed is public; only store documents the watcher marks as its own.
  if (!isTrustSightNotification(row)) return false

  // One read covers both checks: the natural id and the same-second slug.
  const { results } = await env.DB.prepare(
    'SELECT id, slug FROM notifications WHERE id = ? OR slug = ? LIMIT 2'
  ).bind(row.id, row.slug).all()
  const hits = results || []
  if (hits.some((hit) => hit.id === row.id)) return false
  const slugTaken = hits.some((hit) => hit.slug === row.slug)
  const slug = slugTaken ? `${row.slug}-${row.id}` : row.slug

  try {
    await insertRow(env, row, slug)
  } catch (err) {
    // A concurrent same-second writer took the slug between read and insert.
    if (!/UNIQUE constraint failed: notifications\.slug/.test(String(err && err.message))) throw err
    await insertRow(env, row, `${row.slug}-${row.id}`)
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
