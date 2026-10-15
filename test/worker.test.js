import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alertingClusters, attachmentUrl, baseSlug, buildSearchText, ftsQuery, isTrustSightNotification, parseNotification, pickHeadline, resolveDocumentBody, RetryableIngestError, summarize } from '../worker/lib.js'
import { pollNtfy } from '../worker/poller.js'

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

  it('fetches a document delivered as an ntfy attachment', async () => {
    const withAttachment = { message: 'You received a file: attachment.json', attachment: { url: 'https://ntfy.sh/file/x.json' } }
    expect(attachmentUrl({ message: '{"a":1}' }, 'ntfy.sh')).toBeNull()
    expect(attachmentUrl(withAttachment, 'ntfy.sh')).toBe('https://ntfy.sh/file/x.json')
    // An off-host URL is refused, so a forged topic message cannot SSRF.
    expect(attachmentUrl({ message: 'x', attachment: { url: 'https://evil.example/x' } }, 'ntfy.sh')).toBeNull()

    const calls = []
    const body = await resolveDocumentBody(withAttachment, 'ntfy.sh', async (url) => {
      calls.push(url)
      return { ok: true, text: async () => '{"tool":"trustsight","event":"trustsight.alerts","alerts":[]}' }
    })
    expect(calls).toEqual(['https://ntfy.sh/file/x.json'])
    expect(body).toContain('trustsight.alerts')
  })

  it('returns the raw body when an attachment is definitively not a document', async () => {
    const msg = { message: 'You received a file: attachment.json', attachment: { url: 'https://ntfy.sh/file/x.json' } }
    // 404 (the file is gone) and a 2xx that is not JSON are definitive.
    expect(await resolveDocumentBody(msg, 'ntfy.sh', async () => ({ ok: false, status: 404, text: async () => '' }))).toBe(msg.message)
    expect(await resolveDocumentBody(msg, 'ntfy.sh', async () => ({ ok: true, status: 200, text: async () => 'not json' }))).toBe(msg.message)
  })

  it('throws a retryable error when the attachment fetch is transient', async () => {
    // A transient failure must not degrade to "not ours" - that would advance
    // the cursor past the message and lose it. It throws so the poller retries.
    const msg = { message: 'You received a file: attachment.json', attachment: { url: 'https://ntfy.sh/file/x.json' } }
    await expect(resolveDocumentBody(msg, 'ntfy.sh', async () => { throw new Error('boom') }))
      .rejects.toThrow(RetryableIngestError)
    await expect(resolveDocumentBody(msg, 'ntfy.sh', async () => ({ ok: false, status: 503, text: async () => '' })))
      .rejects.toThrow(RetryableIngestError)
  })

  it('builds an AND-of-prefixes FTS query', () => {
    expect(ftsQuery('some-pkg')).toBe('some* pkg*')
    expect(ftsQuery('  ')).toBeNull()
    expect(ftsQuery('H001')).toBe('h001*')
  })

  it('treats context hubs and one-member clusters as not-campaigns', () => {
    // An older watcher shipped hundreds of H061 hubs (one member each) as
    // "campaign cluster(s)"; the feed must not read that as an incident.
    const payload = {
      campaign_cluster: [
        { rule_id: 'H061', members: ['sdl2'], count: 1 },
        { rule_id: 'G001', members: ['lonely'], count: 1 },
        { rule_id: 'G006', members: ['a', 'b'], count: 2 },
        { rule_id: 'G002', members: ['a', 'b'], count: 2 },
      ],
    }
    expect(alertingClusters(payload).map((c) => c.rule_id)).toEqual(['G002'])
    expect(pickHeadline(payload)).toBe('campaign across 2 packages (G002)')
    // With nothing left, the headline falls through, not to a fake campaign.
    expect(pickHeadline({ campaign_cluster: [{ rule_id: 'H061', members: ['sdl2'], count: 1 }] }, 'TrustSight: alive'))
      .toBe('TrustSight: alive')
  })

  it('summarizes packages and rules without duplicates', () => {
    const row = parseNotification(messageEvent())
    const summary = summarize({ ...row, payload: row.payload })
    expect(summary.packages).toEqual(['some-pkg', 'hot-pkg'])
    expect(summary.rules).toEqual(['H088', 'H001', 'R001'])
  })

  it('leads the over-threshold headline with the heaviest finding', () => {
    // The rule list now carries zero-weight declared practices; the headline
    // must name the risk, not the first (possibly weight-0) rule in the list.
    expect(pickHeadline({
      over_threshold: [{
        package: 'hot-pkg', score: 45,
        rules: ['P001', 'R001'],
        findings: [
          { rule_id: 'P001', weight: 0, file: '', line: null },
          { rule_id: 'R001', weight: 30, file: 'PKGBUILD', line: 12 },
        ],
      }],
    })).toBe('hot-pkg scored 45 (R001)')
  })

  it('summarizes findings into rules and searchable file names', () => {
    const summary = summarize({ payload: JSON.stringify({
      over_threshold: [{
        package: 'hot-pkg',
        findings: [{ rule_id: 'NOVELTY', file: '', line: null }, { rule_id: 'P001', file: 'PKGBUILD', line: 3 }],
      }],
    }) })
    expect(summary.rules).toContain('NOVELTY')
    expect(summary.rules).toContain('P001')
    const text = buildSearchText({ payload: {
      over_threshold: [{ package: 'hot-pkg', findings: [{ rule_id: 'R001', file: 'evil.install' }] }],
    } })
    expect(text).toContain('evil.install')
    expect(text).toContain('R001')
  })

  it('names the top signal in the headline, deterministically', () => {
    expect(pickHeadline({ alerts: [{ package: 'b', rule_id: 'H088' }, { package: 'a', rule_id: 'H088' }] }))
      .toBe('H088 on a +1 more')
    expect(pickHeadline({ over_threshold: [{ package: 'hot-pkg', score: 45, rules: ['H001'] }] }))
      .toBe('hot-pkg scored 45 (H001)')
    expect(pickHeadline({ ioc_matches: [{ package: 'bad-pkg', indicator: 'x' }] }))
      .toBe('IOC match on bad-pkg')
    expect(pickHeadline({ impersonation: [{ maintainer: 'evil', count: 3 }] }))
      .toBe('impersonation campaign by evil (3 name-clones)')
    expect(pickHeadline({}, 'TrustSight: alive')).toBe('TrustSight: alive')
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

const INSERT_SQL = `INSERT INTO notifications
  (id, time, event, topic, title, priority, tags, day, slug, message_raw,
   payload, n_alerts, n_over_threshold, n_ioc, n_impersonation, search_text, created_at)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

async function seed(overrides = {}) {
  await env.DB.exec('DELETE FROM notifications')
  const row = parseNotification({ ...messageEvent(), ...overrides })
  await env.DB.prepare(INSERT_SQL).bind(
    row.id, row.time, row.event, row.topic, row.title, row.priority, row.tags,
    row.day, row.slug, row.message_raw, row.payload, row.n_alerts,
    row.n_over_threshold, row.n_ioc, row.n_impersonation, row.search_text, 0
  ).run()
  return row
}

describe('api endpoints', () => {
  beforeEach(async () => { await seed() })

  it('serves the OpenAPI spec and an endpoint index', async () => {
    const spec = await SELF.fetch('https://example.com/api/openapi.json')
    expect(spec.status).toBe(200)
    expect(spec.headers.get('access-control-allow-origin')).toBe('*')
    const doc = await spec.json()
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.paths['/api/latest']).toBeTruthy()
    expect(doc.paths['/api/date/{date}/{timeframe}']).toBeTruthy()

    const index = await SELF.fetch('https://example.com/api/index.json')
    const body = await index.json()
    expect(body.endpoints).toContain('GET /api/latest')
    expect(body.endpoints).toContain('GET /api/openapi.json')
  })

  it('returns the latest notification with its payload', async () => {
    const res = await SELF.fetch('https://example.com/api/latest')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.item.slug).toBe('2026-05-02/120000')
    expect(body.item.iso).toBe('2026-05-02T12:00:00.000Z')
    expect(body.item.payload.event).toBe('trustsight.alerts')
  })

  it('returns the latest n as a list', async () => {
    const res = await SELF.fetch('https://example.com/api/latest/5')
    const body = await res.json()
    expect(body.count).toBe(1)
    expect(body.items[0].packages).toContain('hot-pkg')
  })

  it('filters by date, hour and range', async () => {
    const dated = await (await SELF.fetch('https://example.com/api/date/2026-05-02')).json()
    expect(dated.count).toBe(1)
    const hour = await (await SELF.fetch('https://example.com/api/date/2026-05-02/12')).json()
    expect(hour.count).toBe(1)
    const otherHour = await (await SELF.fetch('https://example.com/api/date/2026-05-02/13')).json()
    expect(otherHour.count).toBe(0)
    const range = await (await SELF.fetch('https://example.com/api/date/2026-05-02/11-13')).json()
    expect(range.count).toBe(1)
    const minutes = await (await SELF.fetch('https://example.com/api/date/2026-05-02/1159-1201')).json()
    expect(minutes.count).toBe(1)
  })

  it('rejects a bad date or timeframe', async () => {
    expect((await SELF.fetch('https://example.com/api/date/2026-02-31')).status).toBe(400)
    expect((await SELF.fetch('https://example.com/api/date/2026-05-02/25')).status).toBe(400)
  })

  it('searches by package and by rule', async () => {
    const pkg = await (await SELF.fetch('https://example.com/api/package/hot-pkg')).json()
    expect(pkg.count).toBe(1)
    const rule = await (await SELF.fetch('https://example.com/api/rule/H001')).json()
    expect(rule.count).toBe(1)
    const none = await (await SELF.fetch('https://example.com/api/package/does-not-exist')).json()
    expect(none.count).toBe(0)
  })

  it('redirects the docs spellings to the reference page', async () => {
    for (const path of ['/api/docs', '/api/docs/', '/api/reference', '/api/']) {
      const res = await SELF.fetch(`https://example.com${path}`, { redirect: 'manual' })
      expect(res.status).toBe(308)
      expect(res.headers.get('location')).toBe('/api')
    }
  })

  it('redirects root API spellings to their /api equivalent', async () => {
    for (const [from, to] of [
      ['/feed', '/api/feed'],
      ['/latest', '/api/latest'],
      ['/date/2026-05-02', '/api/date/2026-05-02'],
      ['/stats', '/api/stats'],
    ]) {
      const res = await SELF.fetch(`https://example.com${from}`, { redirect: 'manual' })
      expect(res.status).toBe(308)
      expect(res.headers.get('location')).toBe(to)
    }
  })

  it('serves JSON to navigation requests (no SPA fallback for /api)', async () => {
    for (const path of ['/api/feed?event=all', '/api/latest']) {
      const res = await SELF.fetch(`https://example.com${path}`, {
        headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
    }
  })

  it('handles CORS preflight', async () => {
    const res = await SELF.fetch('https://example.com/api/latest', { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-methods')).toContain('GET')
  })

  it('reports health from the database', async () => {
    const res = await SELF.fetch('https://example.com/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.db).toBe('ok')
    expect(body.schema).toBe('1')
    expect(body.last).toBe(1777723200)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('poll cursor', () => {
  const ATTACH = 'https://ntfy.sh/file/att.json'

  // A large document (delivered as an attachment) followed by a heartbeat. The
  // alert is published first, so it must be handled before the heartbeat.
  function ndjson() {
    const alert = {
      id: 'attmsg', time: 1777723201, event: 'message', topic: 't', title: 'big',
      message: 'You received a file: attachment.json', attachment: { url: ATTACH },
    }
    const beat = {
      id: 'beatmsg', time: 1777723202, event: 'message', topic: 't',
      title: 'TrustSight: alive',
      message: JSON.stringify({ event: 'trustsight.heartbeat', tool: 'trustsight', title: 'TrustSight: alive' }),
    }
    return `${JSON.stringify(alert)}\n${JSON.stringify(beat)}\n`
  }

  afterEach(() => { vi.unstubAllGlobals() })

  it('does not advance the cursor past a message whose attachment fetch failed', async () => {
    await env.DB.exec('DELETE FROM notifications')
    await env.DB.prepare("UPDATE meta SET value='' WHERE key='cursor'").run()

    let attachmentDown = true
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/json?poll=1')) return new Response(ndjson(), { status: 200 })
      if (u === ATTACH) {
        if (attachmentDown) throw new Error('network down')
        return new Response(JSON.stringify({
          event: 'trustsight.alerts', tool: 'trustsight', title: 'big', alerts: [], over_threshold: [],
        }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }))

    // First poll: the alert's attachment is unreachable, so the loop stops
    // there and the cursor stays put. Nothing after it is committed either.
    const first = await pollNtfy(env)
    expect(first.stored).toBe(0)
    expect(first.cursor).toBe('')
    const afterFirst = await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications').first()
    expect(afterFirst.n).toBe(0)

    // Second poll: the attachment is back. The alert is stored, then the
    // heartbeat, and the cursor advances to the last handled id.
    attachmentDown = false
    const second = await pollNtfy(env)
    expect(second.stored).toBe(2)
    expect(second.cursor).toBe('beatmsg')
    const rows = await env.DB.prepare('SELECT id FROM notifications ORDER BY time').all()
    expect(rows.results.map((r) => r.id)).toEqual(['attmsg', 'beatmsg'])
  })
})
