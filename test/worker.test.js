import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { baseSlug, buildSearchText, ftsQuery, isTrustSightNotification, parseNotification, summarize } from '../worker/lib.js'

function messageEvent(overrides = {}) {
  return {
    id: 'hwQ2YpKdmg',
    time: 1777723200,
    event: 'message',
    topic: 'trustsight',
    title: 'TrustSight: 1 package(s) over threshold',
    priority: 3,
    tags: ['eye'],
    message: JSON.stringify({
      event: 'trustsight.alerts',
      tool: 'trustsight',
      title: 'TrustSight: 1 package(s) over threshold',
      day: '2026-05-01',
      cycle: { added: 3, changed: 41, removed: 2, processed: 44 },
      alerts: [{ package: 'some-pkg', rule_id: 'H088' }],
      over_threshold: [{ package: 'hot-pkg', score: 45, version: '1.0 -> 1.1', rules: ['H001', 'R001'] }],
      ioc_matches: [],
      campaign_cluster: [],
      impersonation: [],
    }),
    ...overrides,
  }
}

describe('lib parsing', () => {
  it('builds a UTC date/time slug', () => {
    expect(baseSlug(1777723200)).toBe('2026-05-02/120000')
  })

  it('parses a TrustSight document and counts its parts', () => {
    const row = parseNotification(messageEvent())
    expect(row.id).toBe('hwQ2YpKdmg')
    expect(row.event).toBe('trustsight.alerts')
    expect(row.day).toBe('2026-05-01')
    expect(row.n_alerts).toBe(1)
    expect(row.n_over_threshold).toBe(1)
    expect(row.search_text).toContain('hot-pkg')
    expect(row.search_text).toContain('H001')
  })

  it('keeps an unparseable message instead of dropping it', () => {
    const row = parseNotification(messageEvent({ message: '{not json' }))
    expect(row.message_raw).toBe('{not json')
    expect(row.payload).toBe('{}')
    expect(row.event).toBe('message')
  })

  it('accepts only documents the watcher marks as its own', () => {
    expect(isTrustSightNotification(parseNotification(messageEvent()))).toBe(true)
    expect(isTrustSightNotification(parseNotification(messageEvent({ message: '{"nope":1}' })))).toBe(false)
  })

  it('builds an AND-of-prefixes FTS query', () => {
    expect(ftsQuery('some-pkg')).toBe('some* pkg*')
    expect(ftsQuery('  ')).toBeNull()
    expect(ftsQuery('H001')).toBe('h001*')
  })

  it('summarizes packages and rules without duplicates', () => {
    const row = parseNotification(messageEvent())
    const summary = summarize({ ...row, payload: row.payload })
    expect(summary.packages).toEqual(['some-pkg', 'hot-pkg'])
    expect(summary.rules).toEqual(['H088', 'H001', 'R001'])
  })
})

describe('notification store', () => {
  it('round-trips a row through D1 and the feed API', async () => {
    await env.DB.exec('DELETE FROM notifications')
    const row = parseNotification(messageEvent())
    await env.DB.prepare(
      `INSERT INTO notifications
        (id, time, event, topic, title, priority, tags, day, slug, message_raw,
         payload, n_alerts, n_over_threshold, n_ioc, n_impersonation, search_text, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      row.id, row.time, row.event, row.topic, row.title, row.priority, row.tags,
      row.day, row.slug, row.message_raw, row.payload, row.n_alerts,
      row.n_over_threshold, row.n_ioc, row.n_impersonation, row.search_text, 0
    ).run()

    const res = await SELF.fetch('https://example.com/api/feed?event=all')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.items).toHaveLength(1)
    expect(data.items[0].packages).toContain('hot-pkg')

    const detail = await SELF.fetch(`https://example.com/api/messages/${row.slug}`)
    expect(detail.status).toBe(200)
    const doc = await detail.json()
    expect(doc.payload.event).toBe('trustsight.alerts')
    expect(doc.message_raw).toContain('some-pkg')
  })

  it('404s an unknown slug', async () => {
    const res = await SELF.fetch('https://example.com/api/messages/2026-01-01/000000')
    expect(res.status).toBe(404)
  })
})

describe('search text', () => {
  it('includes campaign and impersonation members', () => {
    const text = buildSearchText({
      event: 'trustsight.alerts',
      title: 't',
      day: '2026-05-01',
      payload: {
        campaign_cluster: [{ rule_id: 'G005', members: ['a', 'b'] }],
        impersonation: [{ maintainer: 'evil', members: ['x'], targets: ['libuv'] }],
      },
    })
    expect(text).toContain('G005')
    expect(text).toContain('libuv')
    expect(text).toContain('evil')
  })
})
