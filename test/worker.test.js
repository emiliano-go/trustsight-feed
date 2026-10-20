import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { alertingClusters, baseSlug, buildSearchText, ftsQuery, isTrustSightNotification, packageFacts, packageHistory, parseNotification, pickHeadline, summarize } from '../worker/lib.js'
import { ingestDocument, REPLAY_WINDOW_SECONDS } from '../worker/ingest.js'

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
      tool_version: '0.20.2',
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
    expect(pickHeadline(payload)).toBe('Campaign across 2 packages (G002)')
    // With nothing left, the headline falls through, not to a fake campaign.
    expect(pickHeadline({ campaign_cluster: [{ rule_id: 'H061', members: ['sdl2'], count: 1 }] }, 'TrustSight: alive'))
      .toBe('TrustSight: alive')
  })

  it('extracts exactly one package from a document and aggregates its history', () => {
    const payload = {
      over_threshold: [{
        package: 'hot-pkg', score: 45, version: '1.0 -> 1.1',
        rules: ['H001', 'C006'],
        findings: [
          { rule_id: 'C006', file: 'PKGBUILD', line: 2, reason: "maintainer changed, new domain https://evil.example/x" },
        ],
      }],
      alerts: [],
    }
    const facts = packageFacts(payload, 'hot-pkg')
    expect(facts.version).toBe('1.0 -> 1.1')
    expect(facts.rules).toEqual(expect.arrayContaining(['H001', 'C006']))
    expect(packageFacts(payload, 'hot')).toBeNull()

    const history = packageHistory([
      { slug: '2026-05-02/120000', time: 100, event: 'trustsight.alerts', title: 't', payload: JSON.stringify(payload) },
    ], 'hot-pkg')
    expect(history.count).toBe(1)
    expect(history.max_score).toBe(45)
    expect(history.maintainers).toHaveLength(1)
    expect(history.upstreams.map((u) => u.url)).toContain('https://evil.example/x')
    expect(history.rules.find((r) => r.id === 'H001').count).toBe(1)
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

  it('exposes tool_version on the message and on stats', async () => {
    const message = await (await SELF.fetch('https://example.com/api/messages/2026-05-02/120000')).json()
    expect(message.tool_version).toBe('0.20.2')

    const stats = await (await SELF.fetch('https://example.com/api/stats')).json()
    expect(stats.tool_version).toBe('0.20.2')
  })

  it('omits tool_version when the stored payload has none', async () => {
    const doc = JSON.parse(messageEvent().message)
    delete doc.tool_version
    await seed({ message: JSON.stringify(doc) })

    const stats = await (await SELF.fetch('https://example.com/api/stats')).json()
    expect(stats).not.toHaveProperty('tool_version')
    const message = await (await SELF.fetch('https://example.com/api/messages/2026-05-02/120000')).json()
    expect(message).not.toHaveProperty('tool_version')
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

  it('serves a package history with its score, version and rules', async () => {
    const res = await SELF.fetch('https://example.com/api/package/hot-pkg/history')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.package).toBe('hot-pkg')
    expect(body.count).toBe(1)
    expect(body.max_score).toBe(45)
    expect(body.timeline[0].version).toBe('1.0 -> 1.1')
    expect(body.timeline[0].score).toBe(45)

    // A prefix the FTS matched but no document names exactly is not history.
    const prefix = await (await SELF.fetch('https://example.com/api/package/some/history')).json()
    expect(prefix.count).toBe(0)
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

  it('validates a source request before fetching upstream', async () => {
    // A traversal, an absolute path or an off-pattern name never reaches the
    // upstream fetch.
    expect((await SELF.fetch('https://example.com/api/source/pkg?file=../etc/passwd')).status).toBe(400)
    expect((await SELF.fetch('https://example.com/api/source/pkg?file=/etc/passwd')).status).toBe(400)
    expect((await SELF.fetch('https://example.com/api/source/bad%20name')).status).toBe(400)
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

describe('signed direct ingest', () => {
  const enc = new TextEncoder()

  function b64(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes)))
  }

  async function withKeys() {
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey)
    return {
      privateKey: kp.privateKey,
      env: { DB: env.DB, INGEST_PUBLIC_KEY: b64(spki), INGEST_KEY_ID: 'k1' },
    }
  }

  async function sign(privateKey, id, ts, body) {
    const material = enc.encode(`${id}.${ts}.${body}`)
    const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, material)
    return `v1=${b64(sig)}`
  }

  function headersFor(id, ts, sig, extra = {}) {
    const h = new Headers({
      'webhook-id': id, 'webhook-timestamp': String(ts),
      'webhook-key-id': 'k1', 'webhook-signature': sig,
    })
    for (const [k, v] of Object.entries(extra)) h.set(k, v)
    return h
  }

  beforeEach(async () => { await env.DB.exec('DELETE FROM notifications') })

  it('stores a correctly signed document', async () => {
    const { privateKey, env: e } = await withKeys()
    const ts = Math.floor(Date.now() / 1000)
    const doc = JSON.stringify({
      event: 'trustsight.alerts', tool: 'trustsight', title: 'TrustSight: hot-pkg scored 45',
      alerts: [], over_threshold: [{ package: 'hot-pkg', score: 45 }],
    })
    const sig = await sign(privateKey, 'webhook-1', ts, doc)
    const res = await ingestDocument(e, doc, headersFor('webhook-1', ts, sig, { Title: 'TrustSight: hot-pkg scored 45' }))
    expect(res.ok).toBe(true)
    expect(res.stored).toBe(true)
    const row = await env.DB.prepare('SELECT * FROM notifications WHERE id = ?').bind('webhook-1').first()
    expect(row).toBeTruthy()
    expect(row.slug).toBe(baseSlug(ts))
    expect(row.title).toBe('TrustSight: hot-pkg scored 45')
  })

  it('produces the same stored document as the ntfy route', async () => {
    // The whole point: the signed ingest and the ntfy-shaped path are the same
    // API. Only the row id (the source's identity) and the topic differ.
    const { privateKey, env: e } = await withKeys()
    const ts = Math.floor(Date.now() / 1000)
    const doc = messageEvent().message
    const ntfyRow = parseNotification({
      id: 'ntfyid', time: ts, event: 'message', topic: 'trustsight',
      title: 'TrustSight: 1 package(s) over threshold', message: doc,
    })
    const sig = await sign(privateKey, 'webhook-parity', ts, doc)
    const res = await ingestDocument(e, doc, headersFor('webhook-parity', ts, sig, {
      Title: 'TrustSight: 1 package(s) over threshold',
    }))
    expect(res.ok).toBe(true)
    const ingestRow = await env.DB.prepare('SELECT * FROM notifications WHERE id = ?').bind('webhook-parity').first()
    for (const field of ['time', 'event', 'title', 'day', 'payload', 'slug',
      'n_alerts', 'n_over_threshold', 'n_ioc', 'n_impersonation', 'search_text']) {
      expect(ingestRow[field]).toEqual(ntfyRow[field])
    }
  })

  it('rejects a bad signature', async () => {
    const { env: e } = await withKeys()
    const ts = Math.floor(Date.now() / 1000)
    const res = await ingestDocument(e, '{"event":"trustsight.alerts","tool":"trustsight"}',
      headersFor('bad', ts, 'v1=AAAA'))
    expect(res.ok).toBe(false)
    expect(res.status).toBe(401)
  })

  it('rejects a stale timestamp', async () => {
    const { privateKey, env: e } = await withKeys()
    const old = Math.floor(Date.now() / 1000) - REPLAY_WINDOW_SECONDS - 10
    const doc = '{"event":"trustsight.alerts","tool":"trustsight","title":"t"}'
    const sig = await sign(privateKey, 'stale', old, doc)
    const res = await ingestDocument(e, doc, headersFor('stale', old, sig))
    expect(res.status).toBe(401)
    expect(res.error).toBe('stale')
  })

  it('rejects a request missing the signature headers', async () => {
    const { env: e } = await withKeys()
    const res = await ingestDocument(e, '{}', new Headers({}))
    expect(res.status).toBe(400)
  })

  it('is idempotent for a replayed id', async () => {
    const { privateKey, env: e } = await withKeys()
    const ts = Math.floor(Date.now() / 1000)
    const doc = '{"event":"trustsight.alerts","tool":"trustsight","title":"t"}'
    const sig = await sign(privateKey, 'replay', ts, doc)
    const first = await ingestDocument(e, doc, headersFor('replay', ts, sig))
    expect(first.stored).toBe(true)
    const second = await ingestDocument(e, doc, headersFor('replay', ts, sig))
    expect(second.ok).toBe(true)      // the signature is valid; it is deduped
    expect(second.stored).toBe(false)
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications').first()
    expect(n.n).toBe(1)
  })

  it('refuses an unknown key id rather than falling back', async () => {
    const { privateKey, env: e } = await withKeys()
    const ts = Math.floor(Date.now() / 1000)
    const doc = '{"event":"trustsight.alerts","tool":"trustsight"}'
    const sig = await sign(privateKey, 'unknown', ts, doc)
    const headers = headersFor('unknown', ts, sig)
    headers.set('webhook-key-id', 'nope')
    const res = await ingestDocument(e, doc, headers)
    expect(res.status).toBe(401)
    expect(res.error).toBe('unknown_key')
  })
})
