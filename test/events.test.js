import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildEventIndex, campaignEvents, maintainerEvents } from '../worker/lib.js'
import { parseNotification } from '../worker/lib.js'
import { storeRow } from '../worker/store.js'

const PAYLOAD = {
  event: 'trustsight.alerts',
  tool: 'trustsight',
  tool_version: '0.23.0',
  title: 'TrustSight: Campaign across 2 packages (G003)',
  alerts: [
    { package: 'adopted', rule_id: 'H026', old: 'oldm', new: 'newm', maintainer: 'newm' },
  ],
  over_threshold: [],
  ioc_matches: [{ package: 'adopted', indicator: 'domain:evil.example' }],
  campaign_cluster: [{
    rule_id: 'G003',
    campaign_id: 'g003:maintainer',
    campaign_active: true,
    members: ['adopted', 'other'],
    count: 2,
    members_detail: [
      { package: 'adopted', maintainer: 'newm', previous_maintainer: 'oldm', version: '1 -> 2' },
      { package: 'other', maintainer: 'newm' },
    ],
  }],
  impersonation: [],
  refusals: [],
}

function event(overrides = {}) {
  return {
    id: 'events-1', time: 1777723200, event: 'message', topic: 'trustsight',
    title: PAYLOAD.title, priority: 3, tags: ['eye'],
    message: JSON.stringify(PAYLOAD),
    ...overrides,
  }
}

async function reset() {
  await env.DB.exec('DELETE FROM notifications')
  await env.DB.exec('DELETE FROM campaign_events')
  await env.DB.exec('DELETE FROM maintainer_events')
  await env.DB.exec('DELETE FROM ioc_events')
}

async function ingest(overrides = {}, verification = null) {
  const row = parseNotification(event(overrides))
  await storeRow(env, row, verification)
  return row
}

beforeEach(reset)

describe('event index', () => {
  it('extracts campaigns, maintainers and IOCs', () => {
    const index = buildEventIndex(PAYLOAD)
    expect(index.campaigns).toEqual(expect.arrayContaining([
      expect.objectContaining({ campaign_id: 'g003:maintainer', package: 'adopted' }),
    ]))
    expect(index.maintainers).toEqual(expect.arrayContaining([
      expect.objectContaining({ maintainer_key: 'name:newm', package: 'adopted' }),
    ]))
    expect(index.iocs).toEqual([{ indicator: 'domain:evil.example', package: 'adopted' }])
  })

  it('gives a legacy campaign a deterministic id', () => {
    const first = campaignEvents({ campaign_cluster: [{ rule_id: 'G003', members: ['b', 'a'] }] })
    const second = campaignEvents({ campaign_cluster: [{ rule_id: 'G003', members: ['a', 'b'] }] })
    expect(first[0].campaign_id).toBe(second[0].campaign_id)
    expect(first[0].legacy).toBe(1)
  })

  it('uses the email identity when a maintainer string carries one', () => {
    const rows = maintainerEvents({
      alerts: [{ package: 'x', rule_id: 'H026', old: 'Old <old@example.com>', new: 'New <new@example.com>' }],
    })
    expect(rows.map((row) => row.maintainer_key)).toContain('email:new@example.com')
    expect(rows.map((row) => row.maintainer_key)).toContain('email:old@example.com')
  })
})

describe('event APIs', () => {
  it('stores and serves a campaign', async () => {
    await ingest()
    const list = await (await SELF.fetch('https://example.com/api/campaigns')).json()
    expect(list.items[0].campaign_id).toBe('g003:maintainer')
    const detail = await (await SELF.fetch('https://example.com/api/campaign/g003:maintainer')).json()
    expect(detail.members.map((m) => m.package)).toEqual(['adopted', 'other'])
    expect(detail.members[0].maintainer).toBe('newm')
    expect(detail.timeline[0].slug).toBe('2026-05-02/120000')
  })

  it('requires the backfill: an unindexed campaign is not served from a scan', async () => {
    const legacy = campaignEvents({ campaign_cluster: [{ rule_id: 'G003', members: ['adopted', 'other'] }] })[0].campaign_id
    const doc = { ...PAYLOAD, campaign_cluster: [{ rule_id: 'G003', members: ['adopted', 'other'] }] }
    await ingest({ message: JSON.stringify(doc) })
    await env.DB.exec('DELETE FROM campaign_events')
    const res = await SELF.fetch(`https://example.com/api/campaign/${encodeURIComponent(legacy)}`)
    expect(res.status).toBe(404)
  })

  it('serves a maintainer page', async () => {
    await ingest()
    const body = await (await SELF.fetch('https://example.com/api/maintainer/newm')).json()
    expect(body.available).toBe(true)
    expect(body.packages.map((p) => p.package)).toContain('adopted')
    expect(body.campaigns).toContain('g003:maintainer')
  })

  it('exports IOCs in JSON, CSV and STIX', async () => {
    await ingest()
    const json = await (await SELF.fetch('https://example.com/api/iocs')).json()
    expect(json.items[0].indicator).toBe('domain:evil.example')
    const csv = await SELF.fetch('https://example.com/api/iocs?format=csv')
    expect(csv.headers.get('content-type')).toContain('text/csv')
    expect(await csv.text()).toContain('evil.example')
    const stix = await (await SELF.fetch('https://example.com/api/iocs?format=stix')).json()
    expect(stix.type).toBe('bundle')
    expect(stix.objects[0].pattern).toContain('domain-name')
    expect(stix.objects[0].id).toMatch(/^indicator--[0-9a-f-]{36}$/)
  })

  it('serves Atom and JSON Feed projections', async () => {
    await ingest()
    const atom = await SELF.fetch('https://example.com/api/feed.atom')
    expect(atom.headers.get('content-type')).toContain('atom+xml')
    expect(await atom.text()).toContain('<feed')
    const json = await (await SELF.fetch('https://example.com/api/feed.json')).json()
    expect(json.version).toContain('jsonfeed')
    expect(json.items[0].url).toContain('/2026-05-02/120000/')
  })

  it('escapes untrusted text in Atom and neutralises CSV formulas', async () => {
    const doc = {
      ...PAYLOAD,
      alerts: [{ package: 'x<script>', rule_id: 'H001' }],
      campaign_cluster: [],
      ioc_matches: [{ package: 'adopted', indicator: '  =HYPERLINK("x")' }],
    }
    await ingest({ message: JSON.stringify(doc) })
    const atom = await (await SELF.fetch('https://example.com/api/feed.atom')).text()
    expect(atom).not.toContain('<script>')
    expect(atom).toContain('&lt;script&gt;')
    const csv = await (await SELF.fetch('https://example.com/api/iocs?format=csv')).text()
    expect(csv).toContain("'  =HYPERLINK")
  })

  it('rejects path-like campaign ids', async () => {
    const res = await SELF.fetch('https://example.com/api/campaign/..%2Fsecret')
    expect(res.status).toBe(400)
  })

  it('rejects malformed paths and unknown filters', async () => {
    expect((await SELF.fetch('https://example.com/api/campaign/%ZZ')).status).toBe(400)
    expect((await SELF.fetch('https://example.com/api/feed?event=nope')).status).toBe(400)
    expect((await SELF.fetch('https://example.com/api/iocs?format=xml')).status).toBe(400)
  })

  it('sets hardening headers on API responses', async () => {
    const res = await SELF.fetch('https://example.com/api/feed')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('keeps the ingest signature on the message', async () => {
    await ingest({}, {
      webhookId: 'events-1', keyId: 'k1', signedAt: 1777723200,
      signature: 'sig', bodySha256: 'sha',
    })
    const doc = await (await SELF.fetch('https://example.com/api/messages/2026-05-02/120000')).json()
    expect(doc.verification).toMatchObject({ key_id: 'k1', signature: 'sig', body_sha256: 'sha' })
  })
})
