// Watcher liveness.
//
// The feed is push-only: the watcher POSTs every alert, heartbeat and scan
// document to /api/ingest.  When that push path dies, everything on the site
// keeps answering normally while quietly serving yesterday's data - which is
// exactly how a one-day stall looked on 24/11/26.  Nothing upstream notices,
// because the watcher is healthy and still publishing to ntfy.
//
// So the receiver measures its own silence.  `last_ingest_ok_at` is written by
// every accepted document (alerts, heartbeats and scans alike), and a gap
// longer than a few heartbeat intervals means the push path is broken even
// though this Worker is perfectly fine.

const DEFAULT_STALL_MINUTES = 45
const REALERT_SECONDS = 6 * 60 * 60

/** How long silence may last before the watcher reads as unresponsive. */
export function stallThresholdSeconds(env) {
  const configured = Number(env && env.WATCHER_STALL_MINUTES)
  const minutes = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_STALL_MINUTES
  return Math.round(minutes * 60)
}

function lastIngest(env) {
  return env.DB.prepare("SELECT value FROM meta WHERE key = 'last_ingest_ok_at'")
    .first()
    .then((row) => {
      const value = Number(row && row.value)
      return Number.isFinite(value) && value > 0 ? value : null
    })
}

/**
 * Whether the watcher has been heard from recently.
 *
 * `responsive` is null when no document has ever arrived: a brand-new database
 * has no silence to measure, and reporting that as a stall would cry wolf on
 * the first deploy.
 */
export async function watcherState(env, now = Math.floor(Date.now() / 1000)) {
  const last = await lastIngest(env)
  const threshold = stallThresholdSeconds(env)
  if (last === null) {
    return { responsive: null, last_ingest: null, silent_seconds: null, threshold_seconds: threshold }
  }
  const silent = Math.max(0, now - last)
  return {
    responsive: silent <= threshold,
    last_ingest: last,
    silent_seconds: silent,
    threshold_seconds: threshold,
  }
}

/** The ntfy topic the watchdog reports to, or null when it is switched off. */
function alertTopic(env) {
  if (!env || env.WATCHDOG_ALERTS === 'off') return null
  const topic = String(env.WATCHDOG_NTFY_TOPIC || env.NTFY_TOPIC || '').trim()
  return topic || null
}

async function publish(env, topic, title, body, priority = 'high') {
  const server = String(env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '')
  const response = await fetch(`${server}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: {
      Title: title,
      Priority: priority,
      Tags: 'warning',
      'User-Agent': 'trustsight-feed/1.0',
    },
    body,
  })
  return response.ok
}

function readState(rows) {
  const meta = Object.fromEntries((rows || []).map((row) => [row.key, String(row.value)]))
  return { state: meta.watchdog_state || '', alerted: Number(meta.watchdog_alert_at) || 0 }
}

async function writeState(env, state, alerted) {
  const statement = (key, value) => env.DB.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).bind(key, String(value))
  await env.DB.batch([statement('watchdog_state', state), statement('watchdog_alert_at', alerted)])
}

/**
 * One watchdog tick: announce a stall, and announce the recovery.
 *
 * Runs on a cron, not on request, so a silent watcher is reported even when
 * nobody is looking at the site.  The alert repeats every six hours while the
 * stall lasts; a recovery message closes it.  Delivery is best effort - a
 * failed ntfy call must not turn the tick into an error.
 */
export async function watchdogTick(env, now = Math.floor(Date.now() / 1000)) {
  const state = await watcherState(env, now)
  const rows = await env.DB.prepare(
    "SELECT key, value FROM meta WHERE key IN ('watchdog_state', 'watchdog_alert_at')",
  ).all()
  const previous = readState(rows.results)
  const topic = alertTopic(env)
  const silent = state.silent_seconds === null
    ? 'no document has ever arrived'
    : `silent for ${Math.round(state.silent_seconds / 60)} minutes (threshold ${Math.round(state.threshold_seconds / 60)})`

  if (state.responsive === false) {
    const due = previous.state !== 'stalled' || now - previous.alerted >= REALERT_SECONDS
    if (!due) return { ...state, action: 'none' }
    if (topic) {
      await publish(env, topic,
        'TrustSight: watcher non responsive',
        `The feed has received nothing from the watcher: ${silent}.\n` +
        'Alerts, heartbeats and scans are all delivered through the same signed push, so the feed is now serving stale data.')
    }
    await writeState(env, 'stalled', now)
    return { ...state, action: 'stalled' }
  }

  if (previous.state === 'stalled') {
    if (topic) {
      await publish(env, topic,
        'TrustSight: watcher responsive again',
        `Documents are arriving again; the last one was ${state.silent_seconds} seconds ago.`,
        'default')
    }
    await writeState(env, 'ok', previous.alerted)
    return { ...state, action: 'recovered' }
  }
  return { ...state, action: 'none' }
}
