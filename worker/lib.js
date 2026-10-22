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

/** Rules whose firing is a statement about who maintains a package. */
const MAINTAINER_RULES = new Set([
  'C006', 'G003', 'G005', 'H026', 'H044', 'H046', 'H058', 'H060', 'H074', 'H086',
])

const URL_RE = /https?:\/\/[^\s'"()<>\]]+/g

/**
 * Everything one notification says about one package, or null when the
 * notification does not name it. The FTS match can be a prefix (a search for
 * `foo` finds `foobar`), so this is the exact check the history route uses.
 */
export function packageFacts(payload, name) {
  const p = payload || {}
  const over = (p.over_threshold || []).find((o) => o.package === name) || null
  const alerts = (p.alerts || []).filter((a) => a.package === name)
  const refusals = (p.refusals || []).filter((r) => r.package === name)
  const ioc = (p.ioc_matches || []).filter((m) => m.package === name)
  const campaigns = alertingClusters(p).filter((c) => (c.members || []).includes(name))
  const impersonation = (p.impersonation || []).filter((c) => (c.members || []).includes(name))
  if (!over && !alerts.length && !refusals.length && !ioc.length && !campaigns.length && !impersonation.length) return null

  const seen = new Set()
  const findings = [
    ...((over && Array.isArray(over.findings)) ? over.findings : []),
    ...refusals.flatMap((r) => (Array.isArray(r.findings) ? r.findings : [])),
  ].filter((f) => {
    const key = `${f.rule_id}|${f.file}|${f.line}|${f.reason}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const rules = new Set([...(over && over.rules) || []])
  for (const f of findings) rules.add(f.rule_id)
  for (const a of alerts) rules.add(a.rule_id)
  for (const c of campaigns) rules.add(c.rule_id)
  for (const c of impersonation) rules.add('G005')

  return {
    over: Boolean(over),
    version: (over && over.version) || '',
    score: over && Number.isFinite(Number(over.score)) ? Number(over.score) : null,
    last_modified: (over && over.last_modified) || '',
    rules: [...rules].filter(Boolean),
    findings,
    alerts: alerts.map((a) => a.rule_id).filter(Boolean),
    refusal: refusals.length > 0,
    refusal_reasons: refusals.map((r) => r.reason).filter(Boolean),
    ioc: ioc.map((m) => m.indicator).filter(Boolean),
    campaigns: campaigns.map((c) => c.rule_id).filter(Boolean),
    impersonation: impersonation.map((c) => c.maintainer).filter(Boolean),
  }
}

/**
 * Aggregate every stored notification that names a package into one history:
 * a newest-first timeline of what each analysis said, plus the rule, maintainer
 * and upstream facts that can be read from those analyses.
 *
 * The store does not hold a full PKGBUILD revision per notification, so this
 * reports what the documents actually carry: version transitions, scores,
 * rules and findings, maintainer-change signals, and every source URL a
 * finding names (which is how an upstream that was used once survives after
 * the recipe has moved on).
 */
export function packageHistory(rows, name) {
  const timeline = []
  const rules = new Map()
  const maintainers = []
  const upstreams = new Map()
  let first = null
  let last = null
  let maxScore = null

  for (const row of rows) {
    let payload = {}
    try { payload = JSON.parse(row.payload || '{}') } catch { /* keep {} */ }
    const facts = packageFacts(payload, name)
    if (!facts) continue

    const time = Number(row.time) || 0
    if (first === null || time < first) first = time
    if (last === null || time > last) last = time
    if (facts.score !== null && (maxScore === null || facts.score > maxScore)) maxScore = facts.score

    timeline.push({
      slug: row.slug,
      time,
      event: row.event,
      title: row.title,
      headline: pickHeadline(payload, row.title || 'watcher cycle'),
      ...facts,
    })

    for (const id of facts.rules) {
      const rec = rules.get(id) || { id, count: 0, last_seen: 0 }
      rec.count++
      if (time > rec.last_seen) rec.last_seen = time
      rules.set(id, rec)
    }

    const namedMaint = new Set()
    for (const who of facts.impersonation || []) {
      namedMaint.add('G005')
      maintainers.push({
        rule_id: 'G005',
        reason: `listed in an impersonation campaign submitted by ${who || 'one account'}`,
        time,
        slug: row.slug,
      })
    }

    for (const f of facts.findings) {
      const rule = String(f.rule_id || '').toUpperCase()
      const reason = String(f.reason || '')
      if (MAINTAINER_RULES.has(rule) || /maintainer|ownership transition|adopted|orphan/i.test(reason)) {
        namedMaint.add(rule)
        maintainers.push({ rule_id: f.rule_id, reason, time, slug: row.slug })
      }
      for (const m of reason.matchAll(URL_RE)) {
        const url = m[0].replace(/[.,;:]+$/, '')
        const rec = upstreams.get(url) || { url, rule_id: f.rule_id, first_seen: time, last_seen: time, reason }
        if (time < rec.first_seen) rec.first_seen = time
        if (time > rec.last_seen) rec.last_seen = time
        upstreams.set(url, rec)
      }
    }

    // Alert-only documents (a rule id and a package, no finding) still record
    // that a maintainer-change rule fired, even though they carry no names.
    for (const id of facts.rules) {
      const rule = String(id || '').toUpperCase()
      if (MAINTAINER_RULES.has(rule) && !namedMaint.has(rule)) {
        maintainers.push({ rule_id: id, reason: '', time, slug: row.slug })
      }
    }
  }

  timeline.sort((a, b) => b.time - a.time)
  return {
    count: timeline.length,
    first,
    last,
    max_score: maxScore,
    timeline,
    rules: [...rules.values()].sort((a, b) => (b.count - a.count) || a.id.localeCompare(b.id)),
    maintainers: maintainers.sort((a, b) => b.time - a.time),
    upstreams: [...upstreams.values()].sort((a, b) => (b.last_seen - a.last_seen) || a.url.localeCompare(b.url)),
  }
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
  const tool_version = (payload && typeof payload.tool_version === 'string' && payload.tool_version) || undefined
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
    ioc_packages: [...new Set((payload.ioc_matches || []).map((m) => m.package).filter(Boolean))],
    rules,
    tool_version,
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
  const tokens = (String(input || '').toLowerCase().match(/[a-z0-9_]+/g) || []).slice(0, 8)
  if (!tokens.length) return null
  return tokens.map((t) => `${t}*`).join(' ')
}

/** How many single-character edits a token of this length may differ by. */
function fuzzyAllowance(length) {
  if (length <= 2) return 0
  if (length <= 5) return 1
  if (length <= 9) return 2
  return 3
}

/** Optimal-string-alignment distance: edits plus adjacent transpositions. */
function editDistance(a, b) {
  const rows = a.length + 1
  const cols = b.length + 1
  const d = Array.from({ length: rows }, () => new Array(cols).fill(0))
  for (let i = 0; i < rows; i++) d[i][0] = i
  for (let j = 0; j < cols; j++) d[0][j] = j
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[a.length][b.length]
}

/**
 * A typo-tolerant match of *input* against one indexed string, or null.
 *
 * Every query token must match some word exactly, by prefix, or within a
 * length-scaled edit distance (adjacent transpositions count as one edit).
 * Returns the summed distance, so 0 is an exact token match.
 */
export function fuzzyScore(input, text) {
  const tokens = String(input || '').toLowerCase().match(/[a-z0-9_]+/g) || []
  const words = String(text || '').toLowerCase().match(/[a-z0-9_]+/g) || []
  if (!tokens.length || !words.length) return null
  let total = 0
  for (const token of tokens) {
    const allowance = fuzzyAllowance(token.length)
    let best = Infinity
    for (const word of words) {
      if (word === token) { best = 0; break }
      if (word.startsWith(token) || token.startsWith(word)) { best = Math.min(best, 1); continue }
      if (Math.abs(word.length - token.length) > allowance) continue
      const distance = editDistance(token, word)
      if (distance <= allowance) best = Math.min(best, distance)
    }
    if (best === Infinity) return null
    total += best
  }
  return total
}
