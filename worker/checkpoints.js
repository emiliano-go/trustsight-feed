// Signed, append-only checkpoints over the stored notification archive.
//
// A per-notification signature proves the watcher authorised a document.  A
// checkpoint proves a batch of rows existed together at a point in time and
// chains to the previous checkpoint, so deletion or reordering is detectable.
// This module is pure except for the D1 writes in runCheckpoint.

const encoder = new TextEncoder()

function b64ToBytes(value) {
  const bin = atob(value)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

async function sha256Hex(bytes) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', bytes))
}

/** The leaf hash for one stored row. */
export async function leafHash(row) {
  const body = row.body_sha256
    || await sha256Hex(encoder.encode(String(row.message_raw || '')))
  return sha256Hex(encoder.encode(`\u0000${row.slug}\u0000${body}`))
}

function nodeHash(left, right) {
  const leftBytes = hexToBytes(left)
  const rightBytes = hexToBytes(right)
  const data = new Uint8Array(1 + leftBytes.length + rightBytes.length)
  data[0] = 1
  data.set(leftBytes, 1)
  data.set(rightBytes, 1 + leftBytes.length)
  return sha256Hex(data)
}

/** Build the Merkle levels for a list of hex leaf hashes. */
export async function merkleLevels(leaves) {
  const levels = [leaves.slice()]
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1]
    const next = []
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i]
      const right = i + 1 < current.length ? current[i + 1] : left
      next.push(await nodeHash(left, right))
    }
    levels.push(next)
  }
  return levels
}

export async function merkleRoot(leaves) {
  if (!leaves.length) return ''
  const levels = await merkleLevels(leaves)
  return levels[levels.length - 1][0]
}

/** The audit path for one leaf index. */
export async function merkleProof(leaves, index) {
  const levels = await merkleLevels(leaves)
  const path = []
  let cursor = index
  for (let level = 0; level < levels.length - 1; level += 1) {
    const row = levels[level]
    const sibling = cursor % 2 === 0 ? cursor + 1 : cursor - 1
    path.push({
      position: cursor % 2 === 0 ? 'right' : 'left',
      hash: row[sibling] || row[cursor],
    })
    cursor = Math.floor(cursor / 2)
  }
  return { path, root: levels[levels.length - 1][0] }
}

/** Verify one leaf against a root and audit path. */
export async function verifyProof(leaf, path, root) {
  let current = leaf
  for (const step of path || []) {
    current = step.position === 'right'
      ? await nodeHash(current, step.hash)
      : await nodeHash(step.hash, current)
  }
  return current === root
}

export function canonicalCheckpoint(checkpoint) {
  return JSON.stringify({
    id: checkpoint.id,
    generated_at: checkpoint.generated_at,
    from_rowid: checkpoint.from_rowid,
    through_rowid: checkpoint.through_rowid,
    count: checkpoint.count,
    previous_id: checkpoint.previous_id || '',
    previous_root: checkpoint.previous_root || '',
    root_hash: checkpoint.root_hash,
    algorithm: checkpoint.algorithm || 'Ed25519',
    key_id: checkpoint.key_id || '',
  })
}

async function importPrivateKey(env) {
  const raw = env.FEED_CHECKPOINT_PRIVATE_KEY
  if (!raw) throw new Error('checkpoint signing key is not configured')
  return crypto.subtle.importKey('pkcs8', b64ToBytes(raw), { name: 'Ed25519' }, false, ['sign'])
}

const MAX_CHECKPOINT_ROWS = 5000

/**
 * Checkpoint the next batch of notifications.  Returns a summary; an empty
 * batch is a no-op, not an error.  The caller decides whether a failure is
 * fatal to the scheduled invocation.
 */
export async function runCheckpoint(env, nowSeconds = Math.floor(Date.now() / 1000)) {
  // A cron overlap must not fork the chain.  A 5-minute lease is enough for a
  // bounded checkpoint; a crashed run's lease expires rather than wedging.
  const lock = await env.DB.prepare(
    'UPDATE feed_checkpoint_state SET locked_until = ? WHERE id = 1 AND locked_until < ?'
  ).bind(nowSeconds + 300, nowSeconds).run()
  if (!lock.meta || lock.meta.changes !== 1) return { created: false, reason: 'locked' }
  try {
    return await checkpointLocked(env, nowSeconds)
  } finally {
    await env.DB.prepare('UPDATE feed_checkpoint_state SET locked_until = 0 WHERE id = 1').run()
  }
}

async function checkpointLocked(env, nowSeconds) {
  const state = await env.DB.prepare('SELECT * FROM feed_checkpoint_state WHERE id = 1').first()
  const lastRowid = Number(state && state.last_rowid) || 0
  const { results } = await env.DB.prepare(
    `SELECT rowid, slug, body_sha256, message_raw
       FROM notifications
      WHERE rowid > ?
      ORDER BY rowid ASC
      LIMIT ?`
  ).bind(lastRowid, MAX_CHECKPOINT_ROWS).all()
  const rows = results || []
  if (!rows.length) return { created: false, reason: 'no_new_rows' }

  const leaves = []
  for (const row of rows) leaves.push(await leafHash(row))
  const root = await merkleRoot(leaves)
  const throughRowid = Number(rows[rows.length - 1].rowid)
  const checkpoint = {
    id: `cp-${nowSeconds}-${throughRowid}`,
    generated_at: nowSeconds,
    from_rowid: lastRowid + 1,
    through_rowid: throughRowid,
    count: rows.length,
    previous_id: (state && state.last_checkpoint_id) || '',
    previous_root: (state && state.last_root) || '',
    root_hash: root,
    algorithm: 'Ed25519',
    key_id: env.FEED_CHECKPOINT_KEY_ID || '',
  }
  const canonical = canonicalCheckpoint(checkpoint)
  const privateKey = await importPrivateKey(env)
  const signature = bytesToHex(await crypto.subtle.sign(
    { name: 'Ed25519' }, privateKey, encoder.encode(canonical)))
  // The checkpoint is invisible until every leaf and the state update have
  // landed.  A failure leaves an incomplete row that the API filters out and
  // the next run can supersede.
  await env.DB.prepare(
    `INSERT INTO feed_checkpoints
       (id, generated_at, from_rowid, through_rowid, count, previous_id,
        previous_root, root_hash, key_id, algorithm, canonical, signature,
        complete)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(checkpoint.id, checkpoint.generated_at, checkpoint.from_rowid,
    checkpoint.through_rowid, checkpoint.count, checkpoint.previous_id,
    checkpoint.previous_root, checkpoint.root_hash, checkpoint.key_id,
    checkpoint.algorithm, canonical, signature).run()
  const MAX_LEAVES_PER_BATCH = 100
  for (let i = 0; i < rows.length; i += MAX_LEAVES_PER_BATCH) {
    const batch = rows.slice(i, i + MAX_LEAVES_PER_BATCH).map((row, offset) =>
      env.DB.prepare(
        `INSERT INTO feed_checkpoint_leaves
           (checkpoint_id, rowid, slug, leaf_hash, leaf_index)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(checkpoint.id, row.rowid, row.slug, leaves[i + offset], i + offset))
    await env.DB.batch(batch)
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE feed_checkpoints SET complete = 1 WHERE id = ?`
    ).bind(checkpoint.id),
    env.DB.prepare(
      `UPDATE feed_checkpoint_state
          SET last_rowid = ?, last_root = ?, last_checkpoint_id = ?
        WHERE id = 1`
    ).bind(throughRowid, root, checkpoint.id),
  ])
  return { created: true, checkpoint, root, count: rows.length }
}
