import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stallThresholdSeconds, watcherState, watchdogTick } from '../worker/watchdog.js'

const NOW = 1795640000

async function setMeta(key, value) {
  await env.DB.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).bind(key, String(value)).run()
}

async function getMeta(key) {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first()
  return row ? row.value : null
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('watcher liveness', () => {
  it('uses a threshold that spans three heartbeat intervals', () => {
    expect(stallThresholdSeconds({})).toBe(2700)
    expect(stallThresholdSeconds({ WATCHER_STALL_MINUTES: '15' })).toBe(900)
    // A nonsense value falls back rather than disabling the check.
    expect(stallThresholdSeconds({ WATCHER_STALL_MINUTES: 'soon' })).toBe(2700)
  })

  it('reports unknown before any document has arrived', async () => {
    const state = await watcherState(env, NOW)
    expect(state.responsive).toBeNull()
    expect(state.last_ingest).toBeNull()
  })

  it('is responsive inside the window and silent outside it', async () => {
    await setMeta('last_ingest_ok_at', NOW - 600)
    const fresh = await watcherState(env, NOW)
    expect(fresh.responsive).toBe(true)
    expect(fresh.silent_seconds).toBe(600)

    await setMeta('last_ingest_ok_at', NOW - 3600)
    const stale = await watcherState(env, NOW)
    expect(stale.responsive).toBe(false)
    expect(stale.silent_seconds).toBe(3600)
  })

  it('alerts once on a stall, stays quiet, then reports recovery', async () => {
    const calls = []
    vi.stubGlobal('fetch', async (url, init) => {
      calls.push({ url: String(url), title: init.headers.Title, body: init.body })
      return new Response('ok', { status: 200 })
    })
    await setMeta('last_ingest_ok_at', NOW - 7200)

    const first = await watchdogTick({ ...env, WATCHDOG_NTFY_TOPIC: 'watchdog-test' }, NOW)
    expect(first.action).toBe('stalled')
    expect(calls).toHaveLength(1)
    expect(calls[0].title).toContain('non responsive')
    expect(calls[0].body).toContain('120 minutes')
    expect(await getMeta('watchdog_state')).toBe('stalled')

    const second = await watchdogTick({ ...env, WATCHDOG_NTFY_TOPIC: 'watchdog-test' }, NOW + 60)
    expect(second.action).toBe('none')
    expect(calls).toHaveLength(1)

    await setMeta('last_ingest_ok_at', NOW + 120)
    const recovered = await watchdogTick(
      { ...env, WATCHDOG_NTFY_TOPIC: 'watchdog-test' }, NOW + 180)
    expect(recovered.action).toBe('recovered')
    expect(calls).toHaveLength(2)
    expect(calls[1].title).toContain('responsive again')
    expect(await getMeta('watchdog_state')).toBe('ok')
  })

  it('repeats the alert while the stall lasts', async () => {
    const calls = []
    vi.stubGlobal('fetch', async (url) => { calls.push(String(url)); return new Response('ok') })
    await setMeta('last_ingest_ok_at', NOW - 7200)
    const e = { ...env, WATCHDOG_NTFY_TOPIC: 'watchdog-test' }
    await watchdogTick(e, NOW)
    await watchdogTick(e, NOW + 7 * 3600)
    expect(calls).toHaveLength(2)
  })

  it('does not call ntfy when alerts are switched off', async () => {
    let called = 0
    vi.stubGlobal('fetch', async () => { called += 1; return new Response('ok') })
    await setMeta('last_ingest_ok_at', NOW - 7200)
    const result = await watchdogTick({ ...env, WATCHDOG_ALERTS: 'off' }, NOW)
    expect(result.action).toBe('stalled')
    expect(called).toBe(0)
  })

  it('surfaces the stall on /health and /api/stats', async () => {
    await setMeta('last_ingest_ok_at', Math.floor(Date.now() / 1000) - 7200)
    const health = await (await SELF.fetch('https://example.com/health')).json()
    expect(health.watcher.responsive).toBe(false)
    expect(health.watcher.silent_seconds).toBeGreaterThan(7000)
    const stats = await (await SELF.fetch('https://example.com/api/stats')).json()
    expect(stats.watcher.responsive).toBe(false)
  })
})
