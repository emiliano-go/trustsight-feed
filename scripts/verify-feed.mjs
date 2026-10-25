#!/usr/bin/env node
// Verify one stored notification against the feed's published Ed25519 key.
//
//   node scripts/verify-feed.mjs 2026-10-24/220634
//   FEED_URL=https://localhost:8787 node scripts/verify-feed.mjs <slug>
//
// The signature covers `webhook-id.webhook-timestamp.rawbody`; the body hash is
// checked as a second, independent statement about the same bytes.  This is a
// read-only client: it fetches the message and the public key, and nothing else.

import { createPublicKey, verify } from 'node:crypto'

const base = (process.env.FEED_URL || 'https://watcher.trustsight.org').replace(/\/+$/, '')
const slug = process.argv[2]
if (!slug) {
  console.error('usage: node scripts/verify-feed.mjs <slug>')
  process.exit(2)
}

const message = await fetch(`${base}/api/messages/${encodeURIComponent(slug)}`)
if (!message.ok) {
  console.error(`message: HTTP ${message.status}`)
  process.exit(1)
}
const doc = await message.json()
const proof = doc.verification
if (!proof || !proof.signature || !proof.webhook_id) {
  console.error('no signed ingest proof on this notification')
  process.exit(1)
}

const keysResponse = await fetch(`${base}/api/keys`)
if (!keysResponse.ok) {
  console.error(`keys: HTTP ${keysResponse.status}`)
  process.exit(1)
}
const keys = await keysResponse.json()
const key = (keys.keys || []).find((entry) => entry.id === proof.key_id)
if (!key) {
  console.error(`unknown key id: ${proof.key_id}`)
  process.exit(1)
}

const publicKey = createPublicKey({
  key: Buffer.from(key.public_key, 'base64'),
  format: 'der',
  type: 'spki',
})
const signed = Buffer.from(`${proof.webhook_id}.${proof.signed_at}.${doc.message_raw}`)
const ok = verify(null, signed, publicKey, Buffer.from(proof.signature, 'base64'))
const body = Buffer.from(doc.message_raw).toString('hex')
const hash = (await import('node:crypto')).createHash('sha256').update(doc.message_raw).digest('hex')
const bodyOk = !proof.body_sha256 || proof.body_sha256 === hash

console.log(JSON.stringify({
  slug,
  signature: ok ? 'valid' : 'invalid',
  body_sha256: bodyOk ? 'valid' : 'invalid',
  key_id: proof.key_id,
  body_bytes: body.length / 2,
}, null, 2))
process.exit(ok && bodyOk ? 0 : 1)
