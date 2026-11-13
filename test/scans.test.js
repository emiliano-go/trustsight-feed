import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { normalizeScanDocument } from '../worker/scans.js'
import { storeScanDocument } from '../worker/store.js'
import { rollupScans } from '../worker/retention.js'

function payload(overrides = {}) {
  const now = new Date()
  return {
    event: 'trustsight.scans',
    tool: 'trustsight',
    tool_version: '0.28.0',
    cycle_id: `test-${now.getTime()}`,
    started_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    finished_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    partial: false,
    bootstrap: false,
    backfill_day: null,
    chunk_index: 0,
    chunk_count: 1,
    summary: {
      attempted: 2, succeeded: 2, fetch_failed: 0, not_vetted: 0,
      vanished: 0, reserved: 0, with_diff: 1, alerts: 1,
    },
    scans: [
      {
        package: 'alpha', status: 'ok', score: 25, risk: 'medium',
        old_version: '1.0', new_version: '1.1', maintainer: 'one',
        rules: [{ id: 'H037', severity: 'MEDIUM' }],
        coverage_gaps: [], has_diff: true,
        dependency_analysis: {
          requested_depth: -1,
          examined: 3,
          maximum_depth_reached: 2,
          truncated: false,
          note: '',
          flagged_count: 1,
          failed_count: 0,
          flagged: [{
            name: 'dep-a', depth: 1, score: 45, risk: 'high',
            finding_count: 2, via: 'depends', parent: 'alpha', failed: false,
          }],
          failed: [],
        },
      },
      {
        package: 'beta', status: 'ok', score: 0, risk: 'low',
        old_version: '2.0', new_version: '2.0', maintainer: 'two',
        rules: [], coverage_gaps: ['tree_not_analyzed'], has_diff: false,
      },
    ],
    ...overrides,
  }
}

describe('scan validation', () => {
  it('normalizes rules and bounds', () => {
    const doc = normalizeScanDocument(payload())
    expect(doc.cycle.attempted).toBe(2)
    expect(doc.records).toHaveLength(2)
    expect(doc.rules).toEqual([
      expect.objectContaining({ rule_id: 'H037', severity: 'MEDIUM' }),
    ])
  })

  it('rejects an unknown status', () => {
    const doc = payload()
    doc.scans[0].status = 'invented'
    expect(() => normalizeScanDocument(doc)).toThrow(/bad_scan_status/)
  })

  it('rejects a bad chunk sequence', () => {
    expect(() => normalizeScanDocument(payload({ chunk_index: 2, chunk_count: 2 })))
      .toThrow(/bad_chunk_sequence/)
  })
})

describe('scan storage', () => {
  it('is idempotent and never writes a notification row', async () => {
    const doc = payload({ cycle_id: 'cycle-idempotent' })
    await storeScanDocument(env, doc)
    await storeScanDocument(env, doc)
    const cycle = await env.DB.prepare('SELECT * FROM scan_cycles WHERE cycle_id = ?').bind('cycle-idempotent').first()
    expect(cycle.complete).toBe(1)
    expect(cycle.chunks_received).toBe(1)
    const events = await env.DB.prepare('SELECT COUNT(*) AS n FROM scan_events WHERE cycle_id = ?').bind('cycle-idempotent').first()
    expect(events.n).toBe(2)
    const notes = await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE payload LIKE '%cycle-idempotent%'").first()
    expect(notes.n).toBe(0)
  })

  it('completes only after every chunk arrives', async () => {
    const first = payload({ cycle_id: 'cycle-chunks', chunk_index: 0, chunk_count: 2, scans: [payload().scans[0]] })
    const second = payload({ cycle_id: 'cycle-chunks', chunk_index: 1, chunk_count: 2, scans: [payload().scans[1]] })
    await storeScanDocument(env, first)
    let cycle = await env.DB.prepare('SELECT * FROM scan_cycles WHERE cycle_id = ?').bind('cycle-chunks').first()
    expect(cycle.complete).toBe(0)
    await storeScanDocument(env, second)
    cycle = await env.DB.prepare('SELECT * FROM scan_cycles WHERE cycle_id = ?').bind('cycle-chunks').first()
    expect(cycle.complete).toBe(1)
    expect(cycle.chunks_received).toBe(2)
  })

  it('rolls complete old days into daily totals and removes raw rows', async () => {
    const old = new Date(Date.now() - 40 * 86400000)
    const stamp = old.toISOString().replace(/\.\d{3}Z$/, 'Z')
    const day = stamp.slice(0, 10)
    await env.DB.prepare(
      `INSERT INTO scan_cycles
         (cycle_id, started_at, finished_at, received_at, chunk_count,
          chunks_received, complete, attempted, succeeded, alerts)
       VALUES ('old-cycle', ?, ?, 1, 1, 1, 1, 1, 1, 1)`
    ).bind(stamp, stamp).run()
    await env.DB.prepare(
      `INSERT INTO scan_events
         (cycle_id, package, status, score, risk, rules_json,
          coverage_gaps_json, has_diff, time)
       VALUES ('old-cycle', 'old-pkg', 'ok', 20, 'low', '["H037"]', '[]', 1, ?)`
    ).bind(Math.floor(old.getTime() / 1000)).run()
    await rollupScans(env)
    const daily = await env.DB.prepare('SELECT * FROM scan_daily_totals WHERE day = ?').bind(day).first()
    expect(daily.attempted).toBe(1)
    expect(daily.alerts).toBe(1)
    const raw = await env.DB.prepare("SELECT COUNT(*) AS n FROM scan_events WHERE package = 'old-pkg'").first()
    expect(raw.n).toBe(0)
  })

  it('serves the alert-derived analytics endpoints', async () => {
    const summary = await (await SELF.fetch('https://example.com/api/analytics/summary?window=30d')).json()
    expect(summary.totals).toBeDefined()
    expect(Array.isArray(summary.rules)).toBe(true)
    const series = await (await SELF.fetch('https://example.com/api/analytics/timeseries?window=30d&bucket=day')).json()
    expect(Array.isArray(series.rows)).toBe(true)
    const breakdown = await (await SELF.fetch('https://example.com/api/analytics/breakdown?window=30d&dimension=rule')).json()
    expect(Array.isArray(breakdown.rows)).toBe(true)
  })

  it('serves scan and aggregate endpoints', async () => {
    await storeScanDocument(env, payload({ cycle_id: 'cycle-api' }))
    const list = await (await SELF.fetch('https://example.com/api/scans?cycle=cycle-api')).json()
    expect(list.items).toHaveLength(2)
    expect(list.items[0].rules).toBeDefined()
    expect(list.items[0].dependency_analysis.requested_depth).toBe(-1)
    expect(list.items[0].dependency_analysis.flagged[0].name).toBe('dep-a')
    const stats = await (await SELF.fetch('https://example.com/api/scan-stats?window=30d')).json()
    expect(stats.totals.attempted).toBeGreaterThanOrEqual(2)
    const series = await (await SELF.fetch('https://example.com/api/scan-stats/timeseries?window=30d&bucket=day')).json()
    expect(series.rows.length).toBeGreaterThanOrEqual(1)
    const cycle = await (await SELF.fetch('https://example.com/api/scans/cycle-api')).json()
    expect(cycle.cycle.cycle_id).toBe('cycle-api')
    expect(cycle.items[0].dependency_analysis.examined).toBe(3)
  })
})
