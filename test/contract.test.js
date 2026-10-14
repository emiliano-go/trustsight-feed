// Conformance against the real core output.
//
// `worker/lib.js` parses the ntfy alert document the watcher POSTs, and the
// rule catalog explains the ids that document carries.  The unit suite uses a
// hand-written fixture, so a field renamed in core passes here unnoticed.  This
// test runs the *actual* payload core emits (`contract/contract.json`, from
// `python -m trustsight.contract --emit`) through the same parser, and checks
// that every rule id core can emit has a catalog entry.

import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import catalog from '../src/rule-catalog.generated.json'
import {
  buildSearchText, isTrustSightNotification, parseNotification, pickHeadline, summarize,
} from '../worker/lib.js'

const contract = env.TEST_CONTRACT
const meta = describe.skipIf(!contract)
const SAMPLE_TIME = 1777723200

function ntfyEvent(payload) {
  return {
    id: 'contract-1',
    time: SAMPLE_TIME,
    event: 'message',
    topic: 'trustsight',
    title: payload.title,
    priority: 3,
    tags: ['eye'],
    message: JSON.stringify(payload),
  }
}

meta('core contract: alert payload', () => {
  const payload = contract && contract.alert_payload

  it('passes the TrustSight integrity gate', () => {
    const row = parseNotification(ntfyEvent(payload))
    expect(isTrustSightNotification(row)).toBe(true)
  })

  it('ingests every part the payload carries', () => {
    const row = parseNotification(ntfyEvent(payload))
    expect(row.id).toBe('contract-1')
    expect(row.event).toBe('trustsight.alerts')
    expect(row.n_alerts).toBe(payload.alerts.length)
    expect(row.n_over_threshold).toBe(payload.over_threshold.length)
    expect(row.n_ioc).toBe(payload.ioc_matches.length)
    expect(row.n_impersonation).toBe(payload.impersonation.length)
  })

  it('keeps every package, rule and campaign member searchable', () => {
    const row = parseNotification(ntfyEvent(payload))
    const summary = summarize(row)
    const over = payload.over_threshold[0]
    expect(summary.packages).toContain(over.package)
    for (const f of over.findings) {
      expect(summary.rules).toContain(f.rule_id)
    }
    for (const cluster of payload.campaign_cluster) {
      expect(summary.rules).toContain(cluster.rule_id)
      for (const member of cluster.members) expect(summary.packages).toContain(member)
    }

    for (const r of payload.refusals || []) {
      expect(summary.packages).toContain(r.package)
    }

    const text = buildSearchText({ event: row.event, title: row.title, day: row.day, payload })
    expect(text).toContain(over.package)
    // The located findings carry the file, so a filename is searchable.
    expect(text).toContain(over.findings[0].file)
    for (const r of payload.refusals || []) expect(text).toContain(r.package)
  })

  it('derives the same headline the watcher published', () => {
    // core's `_headline` prefixes nothing but `TrustSight: ` on the title; the
    // feed must produce the identical string from the same document.
    const expected = String(payload.title).replace(/^TrustSight:\s*/, '')
    expect(pickHeadline(payload, 'fallback')).toBe(expected)
  })
})

meta('core contract: rule taxonomy', () => {
  it('has a catalog entry for every rule and pseudo-rule core can emit', () => {
    const ids = [...contract.rule_ids, ...contract.pseudo_rule_ids]
    const missing = ids.filter((id) => !catalog[String(id).toLowerCase()])
    expect(missing, `ids with no catalog entry: ${missing.join(', ')}`).toEqual([])
  })

  it('explains every catalog entry with text, and carries no extras', () => {
    // Exact coverage both ways: a short catalog means core emits a rule the
    // feed cannot explain; a long one means the feed holds a rule core does
    // not, which is drift just the same.
    const ids = new Set(
      [...contract.rule_ids, ...contract.pseudo_rule_ids].map((id) => String(id).toLowerCase()),
    )
    expect(Object.keys(catalog).length).toBe(ids.size)
    for (const [id, entry] of Object.entries(catalog)) {
      expect(ids.has(id), `${id} is in the catalog but not the contract`).toBe(true)
      expect(entry.description, `${id} has no description`).toBeTruthy()
    }
  })
})
