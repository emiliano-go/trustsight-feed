// The one write path: both ingestion routes (the signed direct POST and, for
// parity, an ntfy-shaped message) funnel through `storeRow`, so a document
// stored one way is byte-identical to the same document stored the other.

import { isTrustSightNotification, parseNotification } from './lib.js'

/** Resolve the slug to store, appending the source id on a same-second clash. */
export async function resolveSlug(env, base, id) {
  const clash = await env.DB.prepare('SELECT id FROM notifications WHERE slug = ?')
    .bind(base)
    .first()
  if (clash && clash.id !== id) return `${base}-${id}`
  return base
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

/**
 * Parse an ntfy-shaped message into a row (the historical route, kept so the
 * parity test can prove the two routes agree). `msg.message` is the document.
 */
export function rowFromNtfyMessage(msg) {
  return parseNotification(msg)
}
