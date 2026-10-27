/** Formatting shared by the feed and the detail page. */

const pad = (n) => String(n).padStart(2, '0')

/**
 * Split a list into bounded batches.  The watcher's maintainer endpoint
 * accepts at most 100 names per request; a large alert must issue one request
 * per batch rather than leaving every name after the first 100 unknown.
 */
export function chunk(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** `YYYY-MM-DD HH:MM UTC` from a unix-seconds timestamp. */
export function formatUtc(time) {
  if (!time) return ''
  const d = new Date(time * 1000)
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  )
}

/** `UTC+2`, `UTC-3`, `UTC-3:30` - the browser's own offset, signed east. */
export function utcOffsetLabel(date = new Date()) {
  const mins = -date.getTimezoneOffset()
  const sign = mins < 0 ? '-' : '+'
  const abs = Math.abs(mins)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return `UTC${sign}${h}${m ? `:${pad(m)}` : ''}`
}

/**
 * The reader's local time with its offset, then the UTC time, e.g.
 * `2026-10-14 10:35 UTC-3 - 13:35 UTC`. The date is the reader's own day.
 */
export function formatTime(time) {
  if (!time) return ''
  const ms = time * 1000
  const d = new Date(ms)
  const local =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const utc = `${pad(new Date(ms).getUTCHours())}:${pad(new Date(ms).getUTCMinutes())} UTC`
  return `${local} ${utcOffsetLabel(d)} - ${utc}`
}

/** Relative "3m ago" from a unix-seconds timestamp. */
export function relative(time, now = Date.now()) {
  if (!time) return ''
  const delta = Math.max(0, Math.floor(now / 1000) - time)
  if (delta < 60) return 'just now'
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}

/** The newest notification timestamp: an alert and a heartbeat both count. */
export function lastNotification(stats) {
  if (!stats) return null
  const times = [stats.last, stats.last_alert, stats.last_alive]
    .map((value) => (value === null || value === undefined || value === '' ? NaN : Number(value)))
    .filter(Number.isFinite)
  return times.length ? Math.max(...times) : null
}

/** Collapse hard line breaks in prose so the viewport decides where it wraps. */
export function flattenProse(text) {
  return String(text ?? '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Human label for a TrustSight document event. */
export function eventLabel(event) {
  if (event === 'trustsight.alerts') return 'alerts'
  if (event === 'trustsight.heartbeat') return 'heartbeat'
  return String(event || '').replace(/^trustsight\./, '')
}

export function eventBadgeClass(event) {
  if (event === 'trustsight.heartbeat') return 'badge badge--heartbeat'
  return 'badge badge--alerts'
}

export const AUR_PACKAGE = (name) =>
  `https://aur.archlinux.org/packages/${encodeURIComponent(name)}`

/** The raw PKGBUILD on the AUR's cgit, the artifact the finding points at. */
export const AUR_PKGBUILD = (name) =>
  `https://aur.archlinux.org/cgit/aur.git/plain/PKGBUILD?h=${encodeURIComponent(name)}`

/** `PKGBUILD:12`, a bare file, or a bare line - '' when the finding has no
 * location (a novelty, corpus or provenance finding names a fact, not a line). */
export function locationLabel(finding) {
  const file = finding && finding.file
  const line = finding && finding.line
  if (file && line) return `${file}:${line}`
  if (file) return String(file)
  if (line) return `line ${line}`
  return ''
}
