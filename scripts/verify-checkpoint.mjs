#!/usr/bin/env node
// Verify one notification against a signed checkpoint.
//
//   node scripts/verify-checkpoint.mjs <checkpoint-id> <slug>
//
// Checks the checkpoint signature over its canonical payload, then the
// notification's leaf against the checkpoint root.  Read-only.

import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { leafHash, verifyProof } from '../worker/checkpoints.js'

const base = (process.env.FEED_URL || 'https://watcher.trustsight.org').replace(/\/+$/, '')
const [id, slug] = process.argv.slice(2)
if (!id || !slug) {
  console.error('usage: node scripts/verify-checkpoint.mjs <checkpoint-id> <slug>')
  process.exit(2)
}

async function getJson(path) {
  const res = await fetch(`${base}${path}`)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${JSON.stringify(body)}`)
  return body
}

const [checkpoint, proof, message, keys] = await Promise.all([
  getJson(`/api/checkpoints/${encodeURIComponent(id)}`),
  getJson(`/api/checkpoints/${encodeURIComponent(id)}/proof?slug=${encodeURIComponent(slug)}`),
  getJson(`/api/messages/${encodeURIComponent(slug)}`),
  getJson('/api/keys'),
])

const key = (keys.keys || []).find((entry) => entry.id === checkpoint.key_id)
if (!key) throw new Error(`unknown checkpoint key: ${checkpoint.key_id}`)
const publicKey = createPublicKey({
  key: Buffer.from(key.public_key, 'base64'),
  format: 'der',
  type: 'spki',
})
const signatureOk = cryptoVerify(
  null,
  Buffer.from(checkpoint.canonical),
  publicKey,
  Buffer.from(checkpoint.signature, 'hex'),
)
const leaf = await leafHash({
  slug,
  body_sha256: (message.verification && message.verification.body_sha256) || '',
  message_raw: message.message_raw,
})
const proofOk = proof.checkpoint_root === checkpoint.root_hash
  && proof.root_hash === checkpoint.root_hash
  && await verifyProof(leaf, proof.audit_path, checkpoint.root_hash)

console.log(JSON.stringify({
  checkpoint: checkpoint.id,
  slug,
  signature: signatureOk ? 'valid' : 'invalid',
  inclusion: proofOk ? 'valid' : 'invalid',
  root_hash: checkpoint.root_hash,
}, null, 2))
process.exit(signatureOk && proofOk ? 0 : 1)
