import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalCheckpoint, leafHash, merkleProof, merkleRoot, runCheckpoint, verifyProof,
} from '../worker/checkpoints.js'

const enc = new TextEncoder()

function b64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
}

async function keys() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const priv = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
  const pub = await crypto.subtle.exportKey('spki', pair.publicKey)
  return { pair, env: { DB: env.DB, FEED_CHECKPOINT_PRIVATE_KEY: b64(priv), FEED_CHECKPOINT_KEY_ID: 'cp1' }, pub: b64(pub) }
}

async function seed(count = 3) {
  await env.DB.exec('DELETE FROM notifications')
  await env.DB.exec('DELETE FROM feed_checkpoints')
  await env.DB.exec('DELETE FROM feed_checkpoint_leaves')
  await env.DB.exec('UPDATE feed_checkpoint_state SET last_rowid = 0, last_root = "", last_checkpoint_id = "" WHERE id = 1')
  for (let i = 1; i <= count; i += 1) {
    await env.DB.prepare(
      `INSERT INTO notifications
        (id, time, event, topic, title, priority, tags, day, slug, message_raw,
         payload, n_alerts, n_over_threshold, n_ioc, n_impersonation, search_text, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,0,0,'',0)`
    ).bind(`cp-${i}`, 1777723200 + i, 'trustsight.alerts', '', 't', 3, '[]', '',
      `2026-05-02/12000${i}`, JSON.stringify({ event: 'trustsight.alerts', tool: 'trustsight', i }),
      '{}').run()
  }
}

async function rows() {
  const { results } = await env.DB.prepare(
    'SELECT rowid, slug, body_sha256, message_raw FROM notifications ORDER BY rowid ASC'
  ).all()
  return results || []
}

describe('signed checkpoints', () => {
  beforeEach(() => seed())

  it('builds a deterministic root and verifies an inclusion proof', async () => {
    const list = await rows()
    const leaves = []
    for (const row of list) leaves.push(await leafHash(row))
    expect(await merkleRoot(leaves)).toBe(await merkleRoot(leaves))
    const proof = await merkleProof(leaves, 1)
    expect(proof.root).toBe(await merkleRoot(leaves))
    expect(await verifyProof(leaves[1], proof.path, proof.root)).toBe(true)
    expect(await verifyProof(leaves[0], proof.path, proof.root)).toBe(false)
  })

  it('writes a signed checkpoint and links the next one', async () => {
    const { env: e, pair } = await keys()
    const first = await runCheckpoint(e, 1777723300)
    expect(first.created).toBe(true)
    const row = await env.DB.prepare('SELECT * FROM feed_checkpoints').first()
    expect(row.complete).toBe(1)
    const canonical = canonicalCheckpoint({
      id: row.id, generated_at: row.generated_at, from_rowid: row.from_rowid,
      through_rowid: row.through_rowid, count: row.count, previous_id: row.previous_id,
      previous_root: row.previous_root, root_hash: row.root_hash,
      algorithm: row.algorithm, key_id: row.key_id,
    })
    const ok = await crypto.subtle.verify(
      { name: 'Ed25519' }, pair.publicKey,
      new Uint8Array(row.signature.match(/../g).map((b) => Number.parseInt(b, 16))),
      enc.encode(canonical),
    )
    expect(ok).toBe(true)

    await env.DB.prepare(
      `INSERT INTO notifications
        (id, time, event, topic, title, priority, tags, day, slug, message_raw,
         payload, n_alerts, n_over_threshold, n_ioc, n_impersonation, search_text, created_at)
       VALUES ('cp-4', 1777723204, 'trustsight.alerts', '', 't', 3, '[]', '',
               '2026-05-02/120004', '{"event":"trustsight.alerts","i":4}', '{}', 0,0,0,0,'',0)`
    ).run()
    const second = await runCheckpoint(e, 1777723400)
    expect(second.created).toBe(true)
    const next = await env.DB.prepare('SELECT * FROM feed_checkpoints ORDER BY generated_at DESC LIMIT 1').first()
    expect(next.previous_id).toBe(row.id)
    expect(next.previous_root).toBe(row.root_hash)
  })

  it('serves the checkpoint and its inclusion proof', async () => {
    const { env: e } = await keys()
    const result = await runCheckpoint(e, 1777723300)
    const id = result.checkpoint.id
    const list = await (await SELF.fetch('https://example.com/api/checkpoints')).json()
    expect(list.items[0].id).toBe(id)
    const detail = await (await SELF.fetch(`https://example.com/api/checkpoints/${encodeURIComponent(id)}`)).json()
    expect(detail.root_hash).toBe(result.root)
    const proof = await (await SELF.fetch(`https://example.com/api/checkpoints/${encodeURIComponent(id)}/proof?slug=${encodeURIComponent('2026-05-02/120001')}`)).json()
    expect(proof.checkpoint_root).toBe(result.root)
    expect(await verifyProof(proof.leaf_hash, proof.audit_path, proof.root_hash)).toBe(true)
    const health = await (await SELF.fetch('https://example.com/health')).json()
    expect(health.checkpoint.id).toBe(id)
    expect(health.checkpoint.fresh).toBe(false)
  })

  it('is a no-op when there are no new rows', async () => {
    const { env: e } = await keys()
    expect((await runCheckpoint(e, 1777723300)).created).toBe(true)
    expect((await runCheckpoint(e, 1777723400)).created).toBe(false)
  })
})
