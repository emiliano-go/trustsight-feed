// Signed direct ingest: the watcher POSTs each document here, outbound, so the
// feed never depends on polling ntfy.  Every request is verified with an
// Ed25519 signature over "webhook-id.webhook-timestamp.rawbody"; the receiver
// holds only the public key, so a leak of the feed's config cannot forge a
// document.  A replayed request is idempotent on the row id, not re-stored.
//
// The timestamp binds the signature, so a document queued while this endpoint
// was rejecting requests keeps its original timestamp forever.  A short
// freshness window therefore turns any outage longer than the window into a
// permanent stall: the producer retries the head of its queue, every retry is
// rejected as stale, and nothing behind it is ever delivered.  That is exactly
// what happened on 24/11/26 - the D1 row-read limit returned 500s for an hour,
// the watcher's outbox head kept its 18:15 timestamp, and the feed sat a day
// behind while every retry was refused.
//
// Accepting an older signed document is safe because delivery is idempotent:
// the row id is the storage key and body_sha256 is unique, so a replay writes
// nothing, and a late document is stored under its own `time` rather than
// arriving out of order.  Only the future side stays tight, where a skewed
// clock would let a producer name a time that has not happened yet.

import { parseNotification } from './lib.js'
import { storeRow, storeScanDocument } from './store.js'
import { isScanDocument } from './scans.js'

export const MAX_BODY_BYTES = 1_000_000
//: How old a signed document may be and still be accepted.  Long enough to
//: survive an outage measured in days; see the module comment.
export const REPLAY_WINDOW_SECONDS = 30 * 24 * 60 * 60
//: How far ahead of this receiver's clock a producer may be.  A future
//: timestamp is a clock fault, not a retry.
export const MAX_FUTURE_SKEW_SECONDS = 300
export const MAX_WEBHOOK_ID_CHARS = 200
export const MAX_KEY_ID_CHARS = 128
export const MAX_SIGNATURE_CHARS = 512

function b64ToBytes(value) {
  const bin = atob(value)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

/** The SPKI public key (base64) for a key id, current first then previous. */
function publicKeyFor(env, keyId) {
  const current = { id: env.INGEST_KEY_ID || '', pem: env.INGEST_PUBLIC_KEY || '' }
  const previous = { id: env.INGEST_PREVIOUS_KEY_ID || '', pem: env.INGEST_PUBLIC_KEY_PREVIOUS || '' }
  if (keyId) {
    if (keyId === current.id) return current.pem
    if (keyId === previous.id) return previous.pem
    return '' // an id we do not know: refuse rather than fall back
  }
  return current.pem || previous.pem
}

async function importPublicKey(spkiB64) {
  const der = b64ToBytes(spkiB64)
  return crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify'])
}

/**
 * Verify an ingest request. Returns `{ ok: true, id, time }` or
 * `{ ok: false, status, error }`: 401 for a missing/stale/unknown/bad
 * signature, 400 for a missing header shape.
 */
function rawBytes(value) {
  if (value instanceof Uint8Array) return value
  return new TextEncoder().encode(String(value ?? ''))
}

export async function verifyIngest(env, headers, rawBody) {
  const bytes = rawBytes(rawBody)
  const id = headers.get('webhook-id') || ''
  const time = Number(headers.get('webhook-timestamp'))
  const keyId = headers.get('webhook-key-id') || ''
  const sigRaw = headers.get('webhook-signature') || ''
  const sigB64 = sigRaw.startsWith('v1=') ? sigRaw.slice(3) : sigRaw
  if (!id || !Number.isFinite(time) || !sigB64) {
    return { ok: false, status: 400, error: 'missing_signature_headers' }
  }
  if (id.length > MAX_WEBHOOK_ID_CHARS || keyId.length > MAX_KEY_ID_CHARS
      || sigB64.length > MAX_SIGNATURE_CHARS) {
    return { ok: false, status: 400, error: 'signature_headers_too_large' }
  }
  const now = Math.floor(Date.now() / 1000)
  if (now - time > REPLAY_WINDOW_SECONDS) {
    return { ok: false, status: 401, error: 'stale' }
  }
  if (time - now > MAX_FUTURE_SKEW_SECONDS) {
    return { ok: false, status: 401, error: 'future_timestamp' }
  }
  const spki = publicKeyFor(env, keyId)
  if (!spki) return { ok: false, status: 401, error: 'unknown_key' }
  let key
  let sig
  try {
    key = await importPublicKey(spki)
    sig = b64ToBytes(sigB64)
  } catch {
    return { ok: false, status: 401, error: 'bad_signature' }
  }
  const prefix = new TextEncoder().encode(`${id}.${time}.`)
  const data = new Uint8Array(prefix.length + bytes.length)
  data.set(prefix, 0)
  data.set(bytes, prefix.length)
  let valid = false
  try {
    valid = await crypto.subtle.verify('Ed25519', key, sig, data)
  } catch {
    // A malformed signature (wrong length) throws rather than returning false.
    valid = false
  }
  if (!valid) return { ok: false, status: 401, error: 'bad_signature' }
  return { ok: true, id, time, keyId, signedAt: time, signature: sigB64 }
}

/**
 * Verify and store one posted document. The document is the same JSON the
 * watcher sends to ntfy, so the row it produces matches the ntfy route.
 * Returns `{ ok, status, stored, id, error }`.
 */
export async function ingestDocument(env, rawBody, headers) {
  const bytes = rawBytes(rawBody)
  const text = rawBody instanceof Uint8Array ? new TextDecoder().decode(bytes) : String(rawBody ?? '')
  const verdict = await verifyIngest(env, headers, bytes)
  if (!verdict.ok) return verdict
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return { ok: false, status: 400, error: 'malformed' }
  }
  if (isScanDocument(payload)) {
    try {
      const stored = await storeScanDocument(env, payload)
      await noteIngest(env)
      return { ok: true, status: 200, stored, id: verdict.id, scan: true }
    } catch (error) {
      return {
        ok: false,
        status: 400,
        error: String(error && error.message ? error.message : error),
      }
    }
  }
  // The title is derived from the signed body; the unsigned header is not
  // trusted.  An intercepted POST could otherwise rewrite the headline.
  const title = ''
  let row
  try {
    row = parseNotification({
      id: verdict.id, time: verdict.time, event: 'message', topic: '',
      title, message: text,
    })
  } catch {
    return { ok: false, status: 400, error: 'malformed' }
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const bodySha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')
  const stored = await storeRow(env, row, {
    webhookId: verdict.id,
    keyId: verdict.keyId,
    signedAt: verdict.signedAt,
    signature: verdict.signature,
    bodySha256,
  })
  await noteIngest(env)
  return { ok: true, status: 200, stored, id: verdict.id }
}

/** A successful verified request is the liveness signal for ingest. */
async function noteIngest(env) {
  try {
    const now = String(Math.floor(Date.now() / 1000))
    await env.DB.prepare(
      `INSERT INTO meta (key, value) VALUES ('last_ingest_ok_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(now).run()
  } catch {
    /* observability must never fail an accepted notification */
  }
}
