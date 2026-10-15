// Pure helpers shared by the ingest route and the API. No I/O here, so they
// are cheap to unit-test.

/** UTC slug for a notification: `YYYY-MM-DD/HHMMSS` (from the ntfy time). */
export function baseSlug(time) {
  const d = new Date(time * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `/${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  )
}

/**
 * Parse one ntfy `message` event into the row we store.
 *
 * `msg.message` is the TrustSight JSON document as a string. A document that
 * does not parse is still stored: `message_raw` keeps the bytes and `payload`
 * stays `{}`, so a parse failure never loses a notification.
 */
export function parseNotification(msg) {
  const time = Number(msg.time) || 0
  let payload = {}
  let parseError = false
  if (typeof msg.message === 'string' && msg.message.length) {
    try {
      payload = JSON.parse(msg.message)
    } catch {
      parseError = true
    }
  }
  const event = (payload && typeof payload.event === 'string' && payload.event)
    || msg.event
    || 'ntfy.message'
  const title = msg.title || (payload && payload.title) || ''
  const day = (payload && typeof payload.day === 'string' && payload.day) || ''
  const alerts = Array.isArray(payload && payload.alerts) ? payload.alerts : []
  const over = Array.isArray(payload && payload.over_threshold) ? payload.over_threshold : []
  const ioc = Array.isArray(payload && payload.ioc_matches) ? payload.ioc_matches : []
  const imp = Array.isArray(payload && payload.impersonation) ? payload.impersonation : []

  return {
    id: String(msg.id || ''),
    time,
    event,
    tool: (payload && typeof payload.tool === 'string' && payload.tool) || '',
    topic: String(msg.topic || ''),
    title: String(title).slice(0, 500),
    priority: Number.isFinite(Number(msg.priority)) ? Number(msg.priority) : null,
    tags: JSON.stringify(Array.isArray(msg.tags) ? msg.tags : []),
    day,
    slug: baseSlug(time),
    message_raw: typeof msg.message === 'string' ? msg.message : '',
    payload: parseError ? '{}' : JSON.stringify(payload),
    n_alerts: alerts.length,
    n_over_threshold: over.length,
    n_ioc: ioc.length,
    n_impersonation: imp.length,
    search_text: buildSearchText({ event, title, day, payload }),
  }
}

/**
 * The integrity gate. ntfy.sh topics are public by default, so a document is
 * stored only when it carries the TrustSight marker the watcher always sets
 * (`tool = "trustsight"`, or a `trustsight.*` event). This keeps an unrelated
 * publisher on the same topic out of the feed. It is a gate, not a signature:
 * a determined party who knows the topic could still forge the marker.
 */
export function isTrustSightNotification(row) {
  return row.tool === 'trustsight' || String(row.event || '').startsWith('trustsight.')
}

/** The terms a reader searches by, flattened into one FTS-indexed string. */
export function buildSearchText({ event, title, day, payload }) {
  const parts = [title, day, event, payload && payload.tool, payload && payload.event]
  const push = (v) => { if (v !== undefined && v !== null && v !== '') parts.push(String(v)) }
  for (const a of (payload && payload.alerts) || []) { push(a.package); push(a.rule_id) }
  for (const o of (payload && payload.over_threshold) || []) {
    push(o.package); push(o.version)
    for (const r of o.rules || []) push(r)
    // The located findings: the rule id (again) and the file it fired in, so
    // a search for a filename or a zero-weight rule still matches.
    for (const f of o.findings || []) { push(f.rule_id); push(f.file) }
  }
  for (const m of (payload && payload.ioc_matches) || []) { push(m.package); push(m.indicator) }
  for (const c of (payload && payload.campaign_cluster) || []) {
    push(c.rule_id)
    for (const x of c.members || []) push(x)
  }
  for (const im of (payload && payload.impersonation) || []) {
    push(im.maintainer)
    for (const x of im.members || []) push(x)
    for (const x of im.targets || []) push(x)
  }
  for (const r of (payload && payload.refusals) || []) { push(r.package) }
  return [...new Set(parts.filter((p) => p !== undefined && p !== null && p !== ''))].join(' ')
}

/**
 * The campaign clusters worth showing: a `G`-series rule with two or more
 * members.
 *
 * The watcher's correlation sweep also returns weight-0 *context* findings -
 * `H057`/`H060`/`H061` hubs, one member each - and an older build shipped them
 * in `campaign_cluster`, so a routine sweep read as "226 campaign cluster(s)"
 * naming the ecosystem's most depended-on packages. A cluster that is not a
 * `G` rule, or that names a single package, is not a campaign and is filtered
 * here whatever the producer sent.
 */
export function alertingClusters(payload) {
  const clusters = (payload && payload.campaign_cluster) || []
  return clusters.filter((c) => {
    const rule = String((c && c.rule_id) || '')
    return rule.startsWith('G') && rule !== 'G006' &&
      Array.isArray(c.members) && c.members.length >= 2
  })
}

/** A compact list-item projection derived from a stored row and its payload. */export function summarize(row) {
  let payload = {}
  try { payload = JSON.parse(row.payload || '{}') } catch { /* keep {} */ }
  const packages = []
  const rules = []
  const seenPkg = new Set()
  const seenRule = new Set()
  const addPkg = (p) => { if (p && !seenPkg.has(p)) { seenPkg.add(p); packages.push(p) } }
  const addRule = (r) => { if (r && !seenRule.has(r)) { seenRule.add(r); rules.push(r) } }
  for (const a of payload.alerts || []) { addPkg(a.package); addRule(a.rule_id) }
  for (const o of payload.over_threshold || []) {
    addPkg(o.package)
    for (const r of o.rules || []) addRule(r)
    for (const f of o.findings || []) addRule(f.rule_id)
  }
  for (const m of payload.ioc_matches || []) addPkg(m.package)
  for (const c of alertingClusters(payload)) {
    addRule(c.rule_id)
    // The member packages are the campaign; the search index already names
    // them, and leaving them out of the projection showed a campaign with no
    // packages attached to it.
    for (const m of c.members || []) addPkg(m)
  }
  for (const im of payload.impersonation || []) {
    addPkg(im.maintainer)
    for (const x of im.members || []) addPkg(x)
  }
  for (const r of payload.refusals || []) addPkg(r.package)
  return {
    slug: row.slug,
    time: row.time,
    iso: row.time ? new Date(row.time * 1000).toISOString() : null,
    event: row.event,
    title: row.title,
    headline: pickHeadline(payload, row.title || 'watcher cycle'),
    day: row.day,
    priority: row.priority,
    tags: safeTags(row.tags),
    counts: {
      alerts: row.n_alerts,
      over_threshold: row.n_over_threshold,
      ioc: row.n_ioc,
      impersonation: row.n_impersonation,
    },
    packages,
    rules,
  }
}

/**
 * The short, deterministic name for a document, mirroring the watcher's own
 * headline rule: name the most significant signal (impersonation, IOC,
 * campaign, over-threshold package, rule firing), ordered explicitly so the
 * same document always produces the same string. Falls back to the stored
 * title for documents that carry none of these (a heartbeat).
 */
export function pickHeadline(payload, fallback = '') {
  const impersonation = payload.impersonation || []
  if (impersonation.length) {
    const camp = impersonation.reduce((a, b) =>
      (b.count > a.count || (b.count === a.count && String(b.maintainer || '') > String(a.maintainer || ''))) ? b : a)
    return `impersonation campaign by ${camp.maintainer || 'one submitter'} (${camp.count} name-clones)`
  }

  const ioc = payload.ioc_matches || []
  if (ioc.length) {
    const packages = [...new Set(ioc.map((m) => m.package))].sort()
    return ioc.length === 1 ? `IOC match on ${packages[0]}` : `${ioc.length} IOC matches (${packages[0]} first)`
  }

  const clusters = alertingClusters(payload)
  if (clusters.length) {
    const top = clusters.reduce((a, b) =>
      (b.count > a.count || (b.count === a.count && String(b.rule_id) > String(a.rule_id))) ? b : a)
    return `Campaign across ${top.count} packages (${top.rule_id})`
  }

  const refusals = payload.refusals || []
  if (refusals.length) {
    const pkgs = refusals.map((r) => r.package).filter(Boolean).sort()
    if (pkgs.length === 1) return `analysis could not fully read ${pkgs[0]}`
    return `${pkgs.length} packages the analysis could not fully read (${pkgs[0]} first)`
  }

  const over = payload.over_threshold || []
  if (over.length) {
    const ranked = [...over].sort((a, b) => (b.score - a.score) || String(a.package).localeCompare(String(b.package)))
    const top = ranked[0]
    // Lead with the heaviest finding, not rules[0]: the rule list now carries
    // zero-weight declared practices, and "(P001)" names a declaration, not
    // the risk the headline is for.
    const findings = [...(top.findings || [])].sort((a, b) =>
      ((b.weight || 0) - (a.weight || 0)) || String(a.rule_id || '').localeCompare(String(b.rule_id || '')))
    const leadRule = findings[0] ? findings[0].rule_id : (top.rules && top.rules[0])
    const lead = leadRule ? ` (${leadRule})` : ''
    const extra = ranked.length - 1
    return `${top.package} scored ${top.score}${lead}${extra ? ` +${extra} more` : ''}`
  }

  const alerts = payload.alerts || []
  if (alerts.length) {
    const counts = {}
    for (const a of alerts) counts[a.rule_id] = (counts[a.rule_id] || 0) + 1
    const rule = Object.keys(counts).sort((a, b) => (counts[b] - counts[a]) || a.localeCompare(b))[0]
    const packages = [...new Set(alerts.filter((a) => a.rule_id === rule).map((a) => a.package))].sort()
    const extra = alerts.length - 1
    return `${rule} on ${packages[0]}${extra ? ` +${extra} more` : ''}`
  }

  return fallback
}

function safeTags(tags) {
  try { return JSON.parse(tags || '[]') } catch { return [] }
}

/**
 * Turn user input into a safe FTS5 prefix query. Null when nothing usable.
 *
 * Only word characters survive, so the emitted terms cannot carry FTS
 * syntax; hyphenated names (`some-pkg`) become an AND of prefixes
 * (`some* pkg*`), which is what search-as-you-type wants.
 */
export function ftsQuery(input) {
  const tokens = String(input || '').toLowerCase().match(/[a-z0-9_]+/g) || []
  if (!tokens.length) return null
  return tokens.map((t) => `${t}*`).join(' ')
}
