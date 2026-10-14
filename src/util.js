/** Formatting shared by the feed and the detail page. */

const pad = (n) => String(n).padStart(2, '0')

/** `YYYY-MM-DD HH:MM UTC` from a unix-seconds timestamp. */
export function formatUtc(time) {
  if (!time) return ''
  const d = new Date(time * 1000)
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  )
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
