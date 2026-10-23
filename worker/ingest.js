// Signed direct ingest: the watcher POSTs each document here, outbound, so the
// feed never depends on polling ntfy.  Every request is verified with an
// Ed25519 signature over "webhook-id.webhook-timestamp.rawbody"; the receiver
// holds only the public key, so a leak of the feed's config cannot forge a
// document.  A replayed request is idempotent on the row id, not re-stored.

import { parseNotification } from './lib.js'
import { storeRow } from './store.js'

export const MAX_BODY_BYTES = 1_000_000
export const REPLAY_WINDOW_SECONDS = 300
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
export async function verifyIngest(env, headers, rawBody) {
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
  if (Math.abs(Math.floor(Date.now() / 1000) - time) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, status: 401, error: 'stale' }
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
  const data = new TextEncoder().encode(`${id}.${time}.${rawBody}`)
  let valid = false
  try {
    valid = await crypto.subtle.verify('Ed25519', key, sig, data)
  } catch {
    // A malformed signature (wrong length) throws rather than returning false.
    valid = false
  }
  if (!valid) return { ok: false, status: 401, error: 'bad_signature' }
  return { ok: true, id, time }
}

/**
 * Verify and store one posted document. The document is the same JSON the
 * watcher sends to ntfy, so the row it produces matches the ntfy route.
 * Returns `{ ok, status, stored, id, error }`.
 */
export async function ingestDocument(env, rawBody, headers) {
  const verdict = await verifyIngest(env, headers, rawBody)
  if (!verdict.ok) return verdict
  const title = headers.get('Title') || ''
  let row
  try {
    row = parseNotification({
      id: verdict.id, time: verdict.time, event: 'message', topic: '',
      title, message: rawBody,
    })
  } catch {
    return { ok: false, status: 400, error: 'malformed' }
  }
  const stored = await storeRow(env, row)
  return { ok: true, status: 200, stored, id: verdict.id }
}
