// Validation for the feed-only `trustsight.scans` stream.  Kept pure so the
// signed ingest route and the historical import script cannot disagree.

export const SCAN_EVENT = 'trustsight.scans'
export const MAX_SCAN_RECORDS = 1000
export const MAX_SCAN_STRING = 255
export const MAX_SCAN_RULES = 128
export const MAX_SCAN_GAPS = 64

const PACKAGE_RE = /^[A-Za-z0-9@._+-]{1,255}$/
const STATUSES = new Set(['ok', 'fetch_failed', 'not_vetted', 'vanished', 'reserved'])

function text(value, max = MAX_SCAN_STRING) {
  return String(value == null ? '' : value).slice(0, max)
}

function int(value, fallback = 0) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback
}

function scalarList(value, max) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => typeof item === 'string' && item)
    .map((item) => item.slice(0, MAX_SCAN_STRING))
    .slice(0, max)
}

function ruleList(value) {
  if (!Array.isArray(value)) return []
  const rows = []
  const seen = new Set()
  for (const item of value) {
    const id = text(typeof item === 'string' ? item : item && item.id, 64)
    if (!id || seen.has(id)) continue
    seen.add(id)
    rows.push({
      id,
      severity: text(typeof item === 'string' ? '' : item && item.severity, 32),
    })
    if (rows.length >= MAX_SCAN_RULES) break
  }
  return rows
}

export function isScanDocument(payload) {
  return Boolean(payload && payload.event === SCAN_EVENT)
}

/**
 * Validate and normalize one chunk.  Throws on a malformed document: a
 * signed producer that sends an invalid scan document is a producer bug, not
 * a row the feed should guess at.
 */
export function normalizeScanDocument(payload, receivedAt = Math.floor(Date.now() / 1000)) {
  if (!isScanDocument(payload)) throw new Error('not_a_scan_document')
  const cycleId = text(payload.cycle_id, 200)
  if (!cycleId) throw new Error('missing_cycle_id')
  const chunkCount = int(payload.chunk_count, 0)
  const chunkIndex = int(payload.chunk_index, 0)
  if (chunkCount < 1 || chunkCount > 10000 || chunkIndex >= chunkCount) {
    throw new Error('bad_chunk_sequence')
  }
  const scans = Array.isArray(payload.scans) ? payload.scans : []
  if (scans.length > MAX_SCAN_RECORDS) throw new Error('too_many_scans')
  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {}
  const cycle = {
    cycle_id: cycleId,
    started_at: text(payload.started_at, 64),
    finished_at: text(payload.finished_at, 64),
    received_at: int(receivedAt),
    tool_version: text(payload.tool_version, 64),
    partial: payload.partial ? 1 : 0,
    bootstrap: payload.bootstrap ? 1 : 0,
    backfill_day: text(payload.backfill_day, 10),
    chunk_count: chunkCount,
    attempted: int(summary.attempted),
    succeeded: int(summary.succeeded),
    fetch_failed: int(summary.fetch_failed),
    not_vetted: int(summary.not_vetted),
    vanished: int(summary.vanished),
    reserved: int(summary.reserved),
    with_diff: int(summary.with_diff),
    alerts: int(summary.alerts),
  }
  const parsed = Date.parse(cycle.started_at)
  const time = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : int(receivedAt)
  const records = []
  const rules = []
  const seenPackages = new Set()
  for (const raw of scans) {
    if (!raw || typeof raw !== 'object') throw new Error('bad_scan_record')
    const packageName = text(raw.package)
    if (!PACKAGE_RE.test(packageName)) throw new Error('bad_scan_package')
    if (seenPackages.has(packageName)) throw new Error('duplicate_scan_package')
    seenPackages.add(packageName)
    const status = text(raw.status, 32)
    if (!STATUSES.has(status)) throw new Error('bad_scan_status')
    const ruleRows = ruleList(raw.rules)
    const record = {
      cycle_id: cycleId,
      package: packageName,
      status,
      score: status === 'ok' ? Math.max(0, Math.min(100, int(raw.score))) : null,
      risk: text(raw.risk, 32),
      old_version: text(raw.old_version),
      new_version: text(raw.new_version),
      maintainer: text(raw.maintainer),
      rules_json: JSON.stringify(ruleRows.map((rule) => rule.id)),
      coverage_gaps_json: JSON.stringify(scalarList(raw.coverage_gaps, MAX_SCAN_GAPS)),
      has_diff: raw.has_diff ? 1 : 0,
      time,
    }
    records.push(record)
    for (const rule of ruleRows) {
      rules.push({
        cycle_id: cycleId,
        package: packageName,
        rule_id: rule.id,
        severity: rule.severity,
        time,
      })
    }
  }
  return { cycle, records, rules, chunkIndex }
}
