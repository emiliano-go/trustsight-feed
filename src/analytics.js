// Pure helpers for the analytics page.  Kept out of the component so the
// bucketing and label rules are testable without a DOM.

export function bucketTime(value) {
  if (typeof value === 'number') return value
  const text = String(value || '')
  const parsed = Date.parse(text.length === 10 ? `${text}T00:00:00Z` : text)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0
}

export function seriesFromRows(rows, field) {
  return (rows || []).map((row) => [
    bucketTime(row.bucket),
    Number(row[field] || 0),
  ]).filter(([time]) => time > 0)
}

export function percent(value, total) {
  const n = Number(value || 0)
  const d = Number(total || 0)
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0
}

export function compactNumber(value) {
  const n = Number(value || 0)
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
