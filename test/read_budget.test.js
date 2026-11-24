import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { handleApi } from '../worker/api.js'

// The feed's D1 database is on the free tier, whose row-read allowance is
// small enough that one uncached aggregate can end the day for the whole
// site.  These tests pin the read cost of the endpoints the public pages call,
// so a query that starts scanning a table again fails here instead of at
// midnight UTC on the live feed.

const DAY = 86400
const now = Math.floor(Date.now() / 1000)

/** A D1 handle that adds up `rows_read` across every statement it serves. */
function instrumented(db, out) {
  const record = (meta, sql) => {
    const rows = Number(meta?.rows_read || 0)
    out.reads += rows
    out.statements.push({ rows, sql: sql.replace(/\s+/g, ' ').trim().slice(0, 90) })
  }
  const wrap = (bound, sql) => ({
    bind: (...args) => wrap(bound.bind(...args), sql),
    all: async () => { const r = await bound.all(); record(r.meta, sql); return r },
    // first() does not report meta, so it runs as all() and keeps the head.
    first: async () => { const r = await bound.all(); record(r.meta, sql); return (r.results || [])[0] ?? null },
    run: async () => { const r = await bound.run(); record(r.meta, sql); return r },
  })
  return {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    batch: (statements) => db.batch(statements),
    exec: (sql) => db.exec(sql),
  }
}

async function rowsRead(path) {
  const out = { reads: 0, statements: [] }
  const url = new URL(`https://example.com${path}`)
  const response = await handleApi(
    new Request(url.toString()), { ...env, DB: instrumented(env.DB, out) }, url)
  return { status: response.status, reads: out.reads, statements: out.statements }
}

async function seed(volume) {
  const { notifications, campaigns, maintainers, iocs, rules, scans, scanRules } = volume
  const statements = []
  for (let i = 0; i < notifications; i++) {
    const time = now - (i % 30) * DAY
    statements.push(env.DB.prepare(`INSERT INTO notifications
      (id,time,event,topic,title,priority,tags,day,slug,message_raw,payload,
       n_alerts,n_over_threshold,n_ioc,n_impersonation,n_campaigns,n_refusals,
       search_text,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      `id${i}`, time, 'trustsight.alerts', 't', 'title', 3, '[]',
      new Date(time * 1000).toISOString().slice(0, 10), `slug-${i}`, '{}',
      JSON.stringify({ campaign_cluster: i % 10 === 0 ? [{}] : [], refusals: i % 20 === 0 ? [{}] : [] }),
      1, i % 10 === 0 ? 1 : 0, i % 15 === 0 ? 1 : 0, 0,
      i % 10 === 0 ? 1 : 0, i % 20 === 0 ? 1 : 0, `pkg-${i} H001`, time))
  }
  for (let i = 0; i < campaigns; i++) {
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO campaign_events (campaign_id,rule_id,package,time,slug) VALUES (?,?,?,?,?)')
      .bind(`c${i % 20}`, 'G003', `pkg-${i}`, now - (i % 30) * DAY, `slug-${i}`))
  }
  for (let i = 0; i < maintainers; i++) {
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO maintainer_events (maintainer_key,maintainer,package,rule_id,time,slug) VALUES (?,?,?,?,?,?)')
      .bind(`m${i % 20}`, `m${i % 20}`, `pkg-${i}`, 'H026', now - (i % 30) * DAY, `slug-${i}`))
  }
  for (let i = 0; i < iocs; i++) {
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO ioc_events (indicator,package,time,slug) VALUES (?,?,?,?)')
      .bind(`ioc.example/${i % 10}`, `pkg-${i}`, now - (i % 30) * DAY, `slug-${i}`))
  }
  for (let i = 0; i < rules; i++) {
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO rule_events (package,rule_id,severity,weight,file,line,reason,source,campaign_id,time,slug) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(`pkg-${i}`, `H00${i % 9}`, 'MEDIUM', 10, 'PKGBUILD', i, 'r', 'engine', `c${i % 20}`, now - (i % 30) * DAY, `slug-${i}`))
  }
  for (let i = 0; i < scans; i++) {
    const time = now - (i % 30) * DAY
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO scan_cycles (cycle_id,started_at,finished_at,received_at,complete,attempted,succeeded,alerts) VALUES (?,?,?,?,?,?,?,?)')
      .bind(`cy${i % 50}`, new Date(time * 1000).toISOString(), '', time, 1, 5, 5, 1))
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO scan_events (cycle_id,package,status,score,risk,time) VALUES (?,?,?,?,?,?)')
      .bind(`cy${i % 50}`, `pkg-${i}`, 'ok', i % 100, 'Low', time))
  }
  for (let i = 0; i < scanRules; i++) {
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO scan_rule_events (cycle_id,package,rule_id,severity,time) VALUES (?,?,?,?,?)')
      .bind(`cy${i % 50}`, `pkg-${i}`, `H00${i % 9}`, 'MEDIUM', now - (i % 30) * DAY))
  }
  for (let i = 0; i < statements.length; i += 400) await env.DB.batch(statements.slice(i, i + 400))
}

const VOLUME = {
  notifications: 2000, campaigns: 2000, maintainers: 2000, iocs: 500,
  rules: 1500, scans: 1500, scanRules: 4000,
}

describe('the read budget of the public endpoints', () => {
  beforeEach(async () => {
    await seed(VOLUME)
  })

  it('answers /api/stats without scanning the event tables', async () => {
    const result = await rowsRead('/api/stats')
    expect(result.status).toBe(200)
    // One feed_stats row, two newest-event probes, one checkpoint count.
    expect(result.reads).toBeLessThan(40)
    expect(result.statements.some((s) => /COUNT\(\*\) FROM (campaign_events|maintainer_events|ioc_events)/.test(s.sql))).toBe(false)
  })

  it('reports the maintained event counts', async () => {
    const body = await (await handleApi(new Request('https://example.com/api/stats'), env, new URL('https://example.com/api/stats'))).json()
    expect(body.campaigns).toBe(VOLUME.campaigns)
    expect(body.maintainers).toBe(VOLUME.maintainers)
    expect(body.ioc_events).toBe(VOLUME.iocs)
  })

  it('keeps the counters in step with deletes', async () => {
    const before = await (await handleApi(new Request('https://example.com/api/stats'), env, new URL('https://example.com/api/stats'))).json()
    await env.DB.prepare('DELETE FROM campaign_events WHERE campaign_id = ?').bind('c0').run()
    const after = await (await handleApi(new Request('https://example.com/api/stats'), env, new URL('https://example.com/api/stats'))).json()
    const removed = VOLUME.campaigns - (await env.DB.prepare('SELECT COUNT(*) AS c FROM campaign_events').first()).c
    expect(removed).toBeGreaterThan(0)
    expect(after.campaigns).toBe(before.campaigns - removed)
  })

  it('serves the unfiltered feed from the first page only', async () => {
    const result = await rowsRead('/api/feed?limit=20')
    expect(result.status).toBe(200)
    expect(result.reads).toBeLessThan(60)
  })

  it('filters the feed toggles through their partial indexes', async () => {
    for (const toggle of ['campaigns', 'refusals', 'over', 'ioc']) {
      const result = await rowsRead(`/api/feed?${toggle}=1&limit=20`)
      expect(result.status).toBe(200)
      // The index narrows the walk: well under the table size, where the old
      // JSON predicate read every stored notification.
      expect(result.reads).toBeLessThan(VOLUME.notifications / 2)
    }
  })
})
