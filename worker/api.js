// Read API over the D1 store. Public data, so responses are CORS-open for
// anyone who wants to consume the feed from another tool.

import { campaignCommon, ftsQuery, fuzzyScore, maintainerKey, packageHistory, summarize } from './lib.js'
import { atomFeed, jsonFeed } from './feeds.js'
import { merkleProof } from './checkpoints.js'
import { openapiSpec } from './openapi.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const SECONDS_PER_DAY = 86400

const ENDPOINTS = [
  'GET /api (reference page)',
  'GET /api/index.json',
  'GET /api/docs (redirects to /api)',
  'GET /api/openapi.json',
  'GET /api/feed?q=&event=&day=&from=&to=&campaign=&maintainer=&rule=&over=1&ioc=1&campaigns=1&refusals=1&limit=&before=&beforeRow=',
  'GET /api/feed.atom',
  'GET /api/feed.json',
  'GET /api/latest',
  'GET /api/latest/{n}',
  'GET /api/date/{YYYY-MM-DD}',
  'GET /api/date/{YYYY-MM-DD}/{timeframe}',
  'GET /api/package/{name}',
  'GET /api/package/{name}/history',
  'GET /api/rule/{id}',
  'GET /api/rule/{id}/triggers?format=json|csv|ndjson',
  'GET /api/rules',
  'GET /api/triggers?rule=&campaign=&package=&maintainer=&severity=&source=&day=&since=&until=&include=evidence,summary&format=json|csv|ndjson',
  'GET /api/messages/{slug}',
  'GET /api/source/{package}?file=PKGBUILD',
  'GET /api/diff/{package}',
  'GET /api/maintainers?packages=a,b,c',
  'GET /api/campaigns',
  'GET /api/campaign/{id}',
  'GET /api/maintainer/{name}',
  'GET /api/iocs?format=json|ndjson|csv|stix',
  'GET /api/keys',
  'GET /api/checkpoints',
  'GET /api/checkpoints/{id}',
  'GET /api/checkpoints/{id}/proof?slug=',
  'GET /api/stats',
]

// Timeframes: `HH` (one hour), `HH-HH` (whole hours), `HHMM-HHMM` (a range).
const TIMEFRAME_RE = /^(\d{2})(\d{2})?-(\d{2})(\d{2})?$/
const HOUR_RE = /^(\d{2})$/

function safeDecode(value) {
  try { return decodeURIComponent(value) } catch { return null }
}

const EVENTS = new Set(['all', 'trustsight.alerts', 'trustsight.heartbeat'])

function eventFilter(url, fallback) {
  const value = url.searchParams.get('event') || fallback
  return EVENTS.has(value) ? value : null
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=30',
      ...CORS,
    },
  })
}

function redirect(location) {
  return new Response(null, {
    status: 308,
    headers: { location, 'cache-control': 'public, max-age=3600', ...CORS },
  })
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Unix seconds at 00:00:00 UTC of a validated `YYYY-MM-DD`, or null. */
function dayStart(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const ms = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(ms)) return null
  // Reject a date that rolled over (2026-02-31 parses to March).
  if (new Date(ms).toISOString().slice(0, 10) !== date) return null
  return Math.floor(ms / 1000)
}

/** A [from, to] window in unix seconds for a date plus optional timeframe. */
function dateWindow(date, timeframe) {
  const start = dayStart(date)
  if (start === null) return null
  if (!timeframe) return { from: start, to: start + SECONDS_PER_DAY - 1 }

  const hour = timeframe.match(HOUR_RE)
  if (hour) {
    const h = Number(hour[1])
    if (h > 23) return null
    return { from: start + h * 3600, to: start + (h + 1) * 3600 - 1 }
  }

  const range = timeframe.match(TIMEFRAME_RE)
  if (range) {
    const [, h1, m1, h2, m2] = range
    const startH = Number(h1)
    const endH = Number(h2)
    const startM = m1 ? Number(m1) : 0
    const endM = m2 ? Number(m2) : 0
    if (startH > 23 || endH > 23 || startM > 59 || endM > 59) return null
    const from = start + startH * 3600 + startM * 60
    const to = start + endH * 3600 + endM * 60 + 59
    if (to < from) return null
    return { from, to }
  }

  return null
}

// The list projection leaves out `message_raw`, which no list caller reads;
// the detail route still selects the whole row.
const LIST_COLUMNS = `n.slug, n.time, n.event, n.title, n.day, n.priority, n.tags,
  n.n_alerts, n.n_over_threshold, n.n_ioc, n.n_impersonation, n.payload,
  n.rowid AS _rowid`

// A typo leaves FTS with no rows, so the fuzzy fallback rescans a bounded
// window.  Once the corpus is large, only the newest window is scanned; older
// typos are not found, which is the price of a bounded D1 read budget.
const FUZZY_CANDIDATE_LIMIT = 5000
const FUZZY_RECENT_LIMIT = 1000
const MAX_QUERY_CHARS = 200

function asInt(value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : null
}

function queryTokens(input) {
  return String(input || '').toLowerCase().match(/[a-z0-9_]+/g) || []
}

/** Only a token longer than two characters can match inside the allowance. */
function canFuzzy(input) {
  return queryTokens(input).some((token) => token.length > 2)
}

/** The number of newest rows the typo fallback may scan. */
async function fuzzyWindow(env) {
  const row = await env.DB.prepare('SELECT total FROM feed_stats WHERE id = 1').first()
  if (!row) return FUZZY_CANDIDATE_LIMIT
  const total = Number(row.total)
  if (!Number.isFinite(total)) return FUZZY_CANDIDATE_LIMIT
  if (total <= 0) return 0
  return total > FUZZY_CANDIDATE_LIMIT ? FUZZY_RECENT_LIMIT : total
}

/** One paginated query shared by every list endpoint. */
async function listQuery(env, options = {}) {
  const {
    q, event = 'all', day, from, to, beforeTime, beforeRow,
    campaign, maintainer, rule, over, ioc, campaigns, refusals,
    limit = DEFAULT_LIMIT,
  } = options
  const term = typeof q === 'string' ? q.slice(0, MAX_QUERY_CHARS) : q
  const fts = ftsQuery(term)
  const fromTime = asInt(from)
  const toTime = asInt(to)
  const before = asInt(beforeTime)
  const beforeId = asInt(beforeRow)
  const where = []
  const params = []

  if (event && event !== 'all') { where.push('n.event = ?'); params.push(event) }
  if (day) { where.push('n.day = ?'); params.push(day) }
  if (campaign) {
    where.push('EXISTS (SELECT 1 FROM campaign_events ce WHERE ce.slug = n.slug AND ce.campaign_id = ?)')
    params.push(String(campaign).slice(0, 255))
  }
  if (maintainer) {
    where.push('EXISTS (SELECT 1 FROM maintainer_events me WHERE me.slug = n.slug AND me.maintainer_key = ?)')
    params.push(maintainerKey(maintainer))
  }
  if (rule) {
    where.push("(' ' || n.search_text || ' ') LIKE ?")
    params.push(`% ${String(rule).toUpperCase()} %`)
  }
  if (over) where.push('n.n_over_threshold > 0')
  if (ioc) where.push('n.n_ioc > 0')
  if (campaigns) {
    where.push("json_array_length(json_extract(n.payload, '$.campaign_cluster')) > 0")
  }
  if (refusals) {
    where.push("json_array_length(json_extract(n.payload, '$.refusals')) > 0")
  }
  if (fromTime !== null) { where.push('n.time >= ?'); params.push(fromTime) }
  if (toTime !== null) { where.push('n.time <= ?'); params.push(toTime) }
  if (before !== null && beforeId !== null) {
    where.push('(n.time < ? OR (n.time = ? AND n.rowid > ?))')
    params.push(before, before, beforeId)
  }

  const order = 'ORDER BY n.time DESC, n.rowid ASC LIMIT ?'
  const filters = where.length ? `WHERE ${where.join(' AND ')}` : ''
  let results

  if (fts) {
    const ftsWhere = [`f.notifications_fts MATCH ?`, ...where].join(' AND ')
    const attempt = await env.DB.prepare(
      `SELECT ${LIST_COLUMNS}
         FROM notifications n JOIN notifications_fts f ON f.rowid = n.rowid
        WHERE ${ftsWhere} ${order}`
    ).bind(fts, ...params, limit).all()
    results = attempt.results

    // Nothing matched the prefix query: retry typo-tolerantly over the same
    // filters.  Scan only rowid + search_text, then fetch the survivors, so a
    // miss never drags thousands of full payloads out of D1.
    if ((!results || !results.length) && canFuzzy(term)) {
      const window = await fuzzyWindow(env)
      if (window > 0) {
        const candidates = await env.DB.prepare(
          `SELECT n.rowid AS _rowid, n.search_text FROM notifications n ${filters} ${order}`
        ).bind(...params, window).all()
        const matched = (candidates.results || [])
          .filter((row) => fuzzyScore(term, row.search_text) !== null)
          .slice(0, limit)
        if (matched.length) {
          const ids = matched.map((row) => row._rowid)
          const rows = await env.DB.prepare(
            `SELECT ${LIST_COLUMNS} FROM notifications n
              WHERE n.rowid IN (${ids.map(() => '?').join(',')})`
          ).bind(...ids).all()
          const byId = new Map((rows.results || []).map((row) => [row._rowid, row]))
          results = ids.map((id) => byId.get(id)).filter(Boolean)
        } else {
          results = []
        }
      }
    }
  } else {
    const all = await env.DB.prepare(
      `SELECT ${LIST_COLUMNS} FROM notifications n ${filters} ${order}`
    ).bind(...params, limit).all()
    results = all.results
  }

  const items = (results || []).map(summarize)
  const last = results && results.length === limit ? results[results.length - 1] : null
  return { items, next: last ? { before: last.time, beforeRow: last._rowid } : null }
}

function pageFrom(url) {
  return {
    beforeTime: url.searchParams.get('before'),
    beforeRow: url.searchParams.get('beforeRow'),
    limit: clampInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT),
  }
}

function listResponse(env, url, { query, ...options }) {
  return listQuery(env, { ...pageFrom(url), ...options }).then(({ items, next }) =>
    json({ count: items.length, query, items, next }))
}

function messageFromRow(row) {
  let payload = {}
  try { payload = JSON.parse(row.payload || '{}') } catch { /* keep {} */ }
  const verification = row.signature ? {
    algorithm: 'Ed25519',
    webhook_id: row.webhook_id || '',
    key_id: row.key_id || '',
    signed_at: row.signed_at || null,
    signature: row.signature,
    body_sha256: row.body_sha256 || '',
  } : null
  return { ...summarize(row), payload, message_raw: row.message_raw, verification }
}

async function getBySlug(env, slug) {
  const row = await env.DB.prepare('SELECT * FROM notifications WHERE slug = ?').bind(slug).first()
  return row ? messageFromRow(row) : null
}

async function feed(env, url) {
  const event = eventFilter(url, 'trustsight.alerts')
  if (event === null) return json({ error: 'bad_event' }, 400)
  const response = await listResponse(env, url, {
    query: { source: 'feed' },
    q: url.searchParams.get('q'),
    event,
    day: url.searchParams.get('day') || undefined,
    from: url.searchParams.get('from') || undefined,
    to: url.searchParams.get('to') || undefined,
    campaign: url.searchParams.get('campaign') || undefined,
    maintainer: url.searchParams.get('maintainer') || undefined,
    rule: url.searchParams.get('rule') || undefined,
    over: url.searchParams.get('over') === '1',
    ioc: url.searchParams.get('ioc') === '1',
    campaigns: url.searchParams.get('campaigns') === '1',
    refusals: url.searchParams.get('refusals') === '1',
  })
  // The live list is the one response a reader expects to move.  A cached
  // 30-second copy made a newly ingested alert invisible under one filter
  // while a different filter's URL returned it; the feed path is cheap enough
  // to read fresh, and the client also aborts superseded requests.
  response.headers.set('cache-control', 'no-store')
  return response
}

async function latestOne(env) {
  const row = await env.DB.prepare(
    'SELECT * FROM notifications ORDER BY time DESC, rowid ASC LIMIT 1'
  ).first()
  if (!row) return json({ error: 'empty' }, 404)
  return json({ query: { source: 'latest', limit: 1 }, item: messageFromRow(row) })
}

async function latestN(env, url, n) {
  return listResponse(env, url, { query: { source: 'latest', limit: n }, limit: n })
}

async function byDate(env, url, date, timeframe) {
  const window = dateWindow(date, timeframe)
  if (!window) return json({ error: 'bad_date_or_timeframe', date, timeframe }, 400)
  const event = eventFilter(url, 'all')
  if (event === null) return json({ error: 'bad_event' }, 400)
  return listResponse(env, url, {
    query: { source: 'date', date, timeframe: timeframe || null },
    from: window.from,
    to: window.to,
    event,
  })
}

async function packageHistoryResponse(env, name) {
  if (!PACKAGE_RE.test(name)) return json({ error: 'bad_package' }, 400)
  const fts = ftsQuery(name)
  if (!fts) return json({ package: name, ...packageHistory([], name) })
  // The FTS match is a prefix, so read a bounded window and let the exact
  // package check in packageHistory discard the false positives.
  const { results } = await env.DB.prepare(
    `SELECT n.slug, n.time, n.event, n.title, n.payload
       FROM notifications n
       JOIN notifications_fts f ON f.rowid = n.rowid
      WHERE f.notifications_fts MATCH ?
      ORDER BY n.time DESC, n.rowid ASC
      LIMIT 500`
  ).bind(fts).all()
  return json({ package: name, ...packageHistory(results || [], name) })
}

async function bySearch(env, url, term) {
  return listResponse(env, url, {
    query: { source: 'search', term },
    q: term,
    event: url.searchParams.get('event') || 'all',
  })
}

async function message(env, slug) {
  const item = await getBySlug(env, slug)
  if (!item) return json({ error: 'not_found' }, 404)
  return json(item)
}

const PUBLIC_ID_RE = /^[^\x00-\x1f\x7f/\\]{1,255}$/

function publicId(value, max = 255) {
  const text = String(value || '').trim()
  if (!text || text.length > max || !PUBLIC_ID_RE.test(text)) return ''
  return text
}

async function campaigns(env, url) {
  const limit = clampInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT)
  const { results } = await env.DB.prepare(
    `SELECT campaign_id, rule_id, MIN(time) AS first, MAX(time) AS last,
            COUNT(DISTINCT package) AS members, COUNT(DISTINCT slug) AS notifications,
            MAX(legacy) AS legacy,
            (SELECT COUNT(*) FROM rule_events re
              WHERE re.campaign_id = campaign_events.campaign_id
                AND re.rule_id GLOB '[A-Za-z][0-9][0-9][0-9]') AS triggers
       FROM campaign_events
      GROUP BY campaign_id, rule_id
      ORDER BY last DESC, campaign_id ASC
      LIMIT ?`
  ).bind(limit).all()
  return json({
    count: (results || []).length,
    items: (results || []).map((row) => ({ ...row, common: campaignCommon(row) })),
  })
}

async function campaignDetail(env, id) {
  const campaignId = publicId(id)
  if (!campaignId) return json({ error: 'bad_campaign' }, 400)
  const { results } = await env.DB.prepare(
    `SELECT e.rule_id, e.package, e.time, e.slug, e.maintainer,
            e.previous_maintainer, e.version, e.legacy
       FROM campaign_events e
      WHERE e.campaign_id = ?
      ORDER BY e.time ASC, e.slug ASC, e.package ASC`
  ).bind(campaignId).all()
  const rows = results || []
  if (!rows.length) return json({ error: 'not_found' }, 404)
  const triggerRows = await env.DB.prepare(
    `SELECT rule_id, COUNT(*) AS count, COUNT(DISTINCT package) AS packages,
            MIN(time) AS first, MAX(time) AS last
       FROM rule_events WHERE campaign_id = ?
         AND rule_id GLOB '[A-Za-z][0-9][0-9][0-9]'
      GROUP BY rule_id ORDER BY count DESC, rule_id ASC`
  ).bind(campaignId).all()
  const recentTriggers = await env.DB.prepare(
    `SELECT package, rule_id, severity, weight, source, campaign_id, time, slug,
            file, line, reason
       FROM rule_events WHERE campaign_id = ?
         AND rule_id GLOB '[A-Za-z][0-9][0-9][0-9]'
      ORDER BY time DESC, id DESC LIMIT 100`
  ).bind(campaignId).all()
  const events = new Map()
  const members = new Map()
  for (const row of rows) {
    const event = events.get(row.slug) || {
      time: row.time, slug: row.slug, rule_id: row.rule_id, packages: [],
      ownership: [], versions: [],
    }
    event.packages.push(row.package)
    if (row.maintainer || row.previous_maintainer) {
      event.ownership.push({
        package: row.package,
        maintainer: row.maintainer || '',
        previous_maintainer: row.previous_maintainer || '',
      })
    }
    if (row.version) event.versions.push({ package: row.package, version: row.version })
    events.set(row.slug, event)
    const member = members.get(row.package) || {
      package: row.package, first: row.time, last: row.time,
      maintainer: '', previous_maintainer: '', version: '',
    }
    member.last = row.time
    if (row.maintainer) member.maintainer = row.maintainer
    if (row.previous_maintainer) member.previous_maintainer = row.previous_maintainer
    if (row.version) member.version = row.version
    members.set(row.package, member)
  }
  return json({
    id: campaignId,
    rule_id: rows[0].rule_id,
    legacy: Boolean(rows[0].legacy),
    first: rows[0].time,
    last: rows[rows.length - 1].time,
    members: [...members.values()].sort((a, b) => a.package.localeCompare(b.package)),
    timeline: [...events.values()].sort((a, b) => b.time - a.time),
    notifications: [...new Set(rows.map((row) => row.slug))].sort().reverse(),
    triggered_rules: triggerRows.results || [],
    triggers: recentTriggers.results || [],
  })
}

const RULE_ID_RE = /^[A-Za-z]\d{3}$/
const SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', ''])
const TRIGGER_SOURCES = new Set(['finding', 'refusal', 'alert', 'campaign'])
const RULE_ID_SQL = "e.rule_id GLOB '[A-Za-z][0-9][0-9][0-9]'"

function ruleIds(raw) {
  const values = String(raw || '').split(',').map((value) => value.trim().toUpperCase()).filter(Boolean)
  if (!values.length) return []
  return values.every((value) => RULE_ID_RE.test(value)) ? [...new Set(values)] : null
}

/** Shared filters for the rule-trigger extraction endpoints. */
function triggerFilters(url, presetRule) {
  const where = [RULE_ID_SQL]
  const params = []
  const rules = ruleIds(presetRule || url.searchParams.get('rule') || '')
  if (rules === null) return { error: 'bad_rule' }
  if (rules.length) {
    where.push(`e.rule_id IN (${rules.map(() => '?').join(',')})`)
    params.push(...rules)
  }
  const campaign = url.searchParams.get('campaign')
  if (campaign) {
    const id = publicId(campaign)
    if (!id) return { error: 'bad_campaign' }
    where.push('e.campaign_id = ?')
    params.push(id)
  }
  const packageName = url.searchParams.get('package')
  if (packageName) {
    if (!PACKAGE_RE.test(packageName)) return { error: 'bad_package' }
    where.push('e.package = ?')
    params.push(packageName)
  }
  const maintainer = url.searchParams.get('maintainer')
  if (maintainer) {
    where.push(`EXISTS (SELECT 1 FROM maintainer_events me
                        WHERE me.slug = e.slug AND me.package = e.package
                          AND me.maintainer_key = ?)`)
    params.push(maintainerKey(maintainer))
  }
  const severity = String(url.searchParams.get('severity') || '').toUpperCase()
  if (severity) {
    if (!SEVERITIES.has(severity)) return { error: 'bad_severity' }
    where.push('e.severity = ?')
    params.push(severity)
  }
  const source = String(url.searchParams.get('source') || '').toLowerCase()
  if (source) {
    if (!TRIGGER_SOURCES.has(source)) return { error: 'bad_source' }
    where.push('e.source = ?')
    params.push(source)
  }
  const day = url.searchParams.get('day')
  if (day) {
    if (!dayStart(day)) return { error: 'bad_day' }
    where.push('EXISTS (SELECT 1 FROM notifications n WHERE n.slug = e.slug AND n.day = ?)')
    params.push(day)
  }
  const since = asInt(url.searchParams.get('since'))
  const until = asInt(url.searchParams.get('until'))
  if (since !== null) { where.push('e.time >= ?'); params.push(since) }
  if (until !== null) { where.push('e.time <= ?'); params.push(until) }
  return { where, params }
}

const TRIGGER_COLUMNS = ['package', 'rule_id', 'severity', 'weight', 'source',
  'campaign_id', 'time', 'slug']
const TRIGGER_EVIDENCE = ['file', 'line', 'reason']

function triggerRow(row, evidence) {
  const item = {}
  for (const key of TRIGGER_COLUMNS) item[key] = row[key]
  if (evidence) for (const key of TRIGGER_EVIDENCE) item[key] = row[key]
  item.id = row._id
  return item
}

async function triggerSummary(env, filters) {
  const where = filters.where.length ? `WHERE ${filters.where.join(' AND ')}` : ''
  const [rules, packages, campaigns] = await Promise.all([
    env.DB.prepare(
      `SELECT e.rule_id, COUNT(*) AS count, COUNT(DISTINCT e.package) AS packages,
              MIN(e.time) AS first, MAX(e.time) AS last
         FROM rule_events e ${where}
        GROUP BY e.rule_id ORDER BY count DESC, e.rule_id ASC LIMIT 100`
    ).bind(...filters.params).all(),
    env.DB.prepare(
      `SELECT e.package, COUNT(*) AS count, COUNT(DISTINCT e.rule_id) AS rules,
              MIN(e.time) AS first, MAX(e.time) AS last
         FROM rule_events e ${where}
        GROUP BY e.package ORDER BY count DESC, e.package ASC LIMIT 100`
    ).bind(...filters.params).all(),
    env.DB.prepare(
      `SELECT e.campaign_id, COUNT(*) AS count, COUNT(DISTINCT e.package) AS packages,
              MIN(e.time) AS first, MAX(e.time) AS last
         FROM rule_events e ${where ? `${where} AND` : 'WHERE'} e.campaign_id != ''
        GROUP BY e.campaign_id ORDER BY count DESC, e.campaign_id ASC LIMIT 100`
    ).bind(...filters.params).all(),
  ])
  return {
    rules: rules.results || [],
    packages: packages.results || [],
    campaigns: campaigns.results || [],
  }
}

function triggerExtractResponse(env, rows, { url, filters, next }) {
  const format = String(url.searchParams.get('format') || 'json').toLowerCase()
  if (!['json', 'csv', 'ndjson'].includes(format)) return json({ error: 'bad_format' }, 400)
  const include = new Set(String(url.searchParams.get('include') || '').split(',').map((v) => v.trim()))
  const evidence = include.has('evidence')
  if (format === 'csv') {
    const columns = [...TRIGGER_COLUMNS, ...(evidence ? TRIGGER_EVIDENCE : [])]
    const lines = [columns.join(',')]
    for (const row of rows) lines.push(columns.map((key) => csvCell(row[key])).join(','))
    return new Response(`${lines.join('\n')}\n`, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="trustsight-triggers.csv"',
        'cache-control': 'public, max-age=60',
        ...CORS,
      },
    })
  }
  if (format === 'ndjson') {
    return new Response(rows.map((row) => JSON.stringify(triggerRow(row, evidence))).join('\n') + (rows.length ? '\n' : ''), {
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'public, max-age=60', ...CORS },
    })
  }
  const summary = include.has('summary') ? triggerSummary(env, filters) : Promise.resolve(undefined)
  return summary.then((aggregates) => json({
    count: rows.length,
    query: { source: 'triggers', ...filters.query },
    items: rows.map((row) => triggerRow(row, evidence)),
    summary: aggregates,
    next,
  }))
}

async function triggers(env, url, presetRule = '') {
  const filters = triggerFilters(url, presetRule)
  if (filters.error) return json({ error: filters.error }, 400)
  const limit = clampInt(url.searchParams.get('limit'), 200, 1, 1000)
  const before = asInt(url.searchParams.get('before'))
  const where = [...filters.where]
  const params = [...filters.params]
  if (before !== null) { where.push('e.id < ?'); params.push(before) }
  const evidence = String(url.searchParams.get('include') || '').split(',').map((v) => v.trim()).includes('evidence')
  const columns = [...TRIGGER_COLUMNS.map((key) => `e.${key}`), 'e.id AS _id',
    ...(evidence ? TRIGGER_EVIDENCE.map((key) => `e.${key}`) : [])]
  const { results } = await env.DB.prepare(
    `SELECT ${columns.join(', ')} FROM rule_events e
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.time DESC, e.id DESC LIMIT ?`
  ).bind(...params, limit).all()
  const rows = results || []
  const next = rows.length === limit ? { before: rows[rows.length - 1]._id } : null
  filters.query = {
    rule: ruleIds(presetRule || url.searchParams.get('rule') || '') || [],
    campaign: url.searchParams.get('campaign') || '',
    package: url.searchParams.get('package') || '',
    maintainer: url.searchParams.get('maintainer') || '',
    severity: url.searchParams.get('severity') || '',
    source: url.searchParams.get('source') || '',
    day: url.searchParams.get('day') || '',
    since: url.searchParams.get('since') || '',
    until: url.searchParams.get('until') || '',
  }
  return triggerExtractResponse(env, rows, { url, filters, next })
}

async function rules(env, url) {
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500)
  const { results } = await env.DB.prepare(
    `SELECT e.rule_id, MAX(e.severity) AS severity, COUNT(*) AS count,
            COUNT(DISTINCT e.package) AS packages, MIN(e.time) AS first,
            MAX(e.time) AS last
       FROM rule_events e
      WHERE e.rule_id GLOB '[A-Za-z][0-9][0-9][0-9]'
      GROUP BY e.rule_id ORDER BY count DESC, e.rule_id ASC LIMIT ?`
  ).bind(limit).all()
  return json({ count: (results || []).length, items: results || [] })
}

async function maintainerDetail(env, name, url) {
  const display = String(name || '').trim()
  if (!display || display.length > 255 || /[\x00-\x1f\x7f]/.test(display)) {
    return json({ error: 'bad_maintainer' }, 400)
  }
  const key = maintainerKey(display)
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, MAX_LIMIT)
  const { results } = await env.DB.prepare(
    `SELECT maintainer, package, previous_maintainer, rule_id, time, slug
       FROM maintainer_events
      WHERE maintainer_key = ?
      ORDER BY time DESC, slug DESC
      LIMIT ?`
  ).bind(key, limit).all()
  const rows = results || []
  if (!rows.length) {
    return json({ maintainer: display, key, available: false, packages: [],
                  transitions: [], campaigns: [], recent_alerts: [] })
  }
  const packages = new Map()
  for (const row of rows) {
    const pkg = packages.get(row.package) || {
      package: row.package, first: row.time, last: row.time,
      previous_maintainer: '', rule_ids: [],
    }
    pkg.last = Math.max(pkg.last, row.time)
    pkg.first = Math.min(pkg.first, row.time)
    if (row.previous_maintainer) pkg.previous_maintainer = row.previous_maintainer
    if (row.rule_id && !pkg.rule_ids.includes(row.rule_id)) pkg.rule_ids.push(row.rule_id)
    packages.set(row.package, pkg)
  }
  const campaignRows = await env.DB.prepare(
    `SELECT DISTINCT ce.campaign_id
       FROM maintainer_events me
       JOIN campaign_events ce ON ce.slug = me.slug AND ce.package = me.package
      WHERE me.maintainer_key = ?
      ORDER BY ce.campaign_id`
  ).bind(key).all()
  const iocRows = await env.DB.prepare(
    `SELECT DISTINCT package FROM ioc_events WHERE package IN (${[...packages.keys()].map(() => '?').join(',') || "''"})`
  ).bind(...[...packages.keys()]).all()
  return json({
    maintainer: rows[0].maintainer || display,
    key,
    available: true,
    first: rows[rows.length - 1].time,
    last: rows[0].time,
    packages: [...packages.values()].sort((a, b) => b.last - a.last),
    transitions: rows.filter((row) => row.previous_maintainer || row.rule_id).slice(0, 200),
    campaigns: (campaignRows.results || []).map((row) => row.campaign_id),
    ioc_packages: (iocRows.results || []).map((row) => row.package),
    recent_alerts: [...new Set(rows.map((row) => row.slug))].slice(0, 50),
  })
}

function csvCell(value) {
  let text = String(value ?? '')
  // A spreadsheet treats a leading = + - @ as a formula.  Prefix it so an
  // IOC value is inert when the CSV is opened, not only when it is read.
  if (/^[ \t\r]*[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

function iocStix(rows) {
  const objects = rows.map((row, index) => {
    const safe = (text) => String(text || '').replace(/[\\'\r\n\u0000-\u001f\u007f-\u009f]/g, '')
    const indicator = safe(row.indicator)
    const [kind, ...rest] = indicator.split(':')
    const value = safe(rest.join(':'))
    const pattern = kind === 'hash'
      ? `[file:hashes.'SHA-256' = '${value}']`
      : kind === 'domain'
        ? `[domain-name:value = '${value}']`
        : kind === 'url'
          ? `[url:value = '${value}']`
          : kind === 'ip'
            ? `[ipv4-addr:value = '${value}']`
            : `[x-trustsight-indicator:value = '${safe(indicator)}']`
    return {
      type: 'indicator',
      spec_version: '2.1',
      id: `indicator--${crypto.randomUUID()}`,
      created: new Date((row.first || 0) * 1000).toISOString(),
      modified: new Date((row.last || 0) * 1000).toISOString(),
      name: indicator,
      pattern,
      pattern_type: 'stix',
      valid_from: new Date((row.first || 0) * 1000).toISOString(),
      labels: ['malicious-activity'],
      x_trustsight_package: row.package,
    }
  })
  return { type: 'bundle', id: 'bundle--trustsight-iocs', objects }
}

async function iocs(env, url) {
  const limit = clampInt(url.searchParams.get('limit'), MAX_LIMIT, 1, MAX_LIMIT)
  const where = []
  const params = []
  const since = asInt(url.searchParams.get('since'))
  const until = asInt(url.searchParams.get('until'))
  const pkg = String(url.searchParams.get('package') || '').trim()
  if (since !== null) { where.push('time >= ?'); params.push(since) }
  if (until !== null) { where.push('time <= ?'); params.push(until) }
  if (pkg) { where.push('package = ?'); params.push(pkg.slice(0, 255)) }
  const filters = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const { results } = await env.DB.prepare(
    `SELECT indicator, package, MIN(time) AS first, MAX(time) AS last,
            COUNT(*) AS count, MAX(slug) AS last_slug
       FROM ioc_events ${filters}
      GROUP BY indicator, package
      ORDER BY last DESC, indicator ASC
      LIMIT ?`
  ).bind(...params, limit).all()
  const rows = results || []
  const format = String(url.searchParams.get('format') || 'json').toLowerCase()
  if (!['json', 'ndjson', 'csv', 'stix'].includes(format)) {
    return json({ error: 'bad_format' }, 400)
  }
  if (format === 'csv') {
    const lines = ['indicator,package,first_seen,last_seen,count,last_slug']
    for (const row of rows) {
      lines.push([row.indicator, row.package,
        new Date((row.first || 0) * 1000).toISOString(),
        new Date((row.last || 0) * 1000).toISOString(),
        row.count, row.last_slug].map(csvCell).join(','))
    }
    return new Response(`${lines.join('\n')}\n`, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="trustsight-iocs.csv"',
        'cache-control': 'public, max-age=60',
        ...CORS,
      },
    })
  }
  if (format === 'ndjson') {
    return new Response(rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), {
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'public, max-age=60', ...CORS },
    })
  }
  if (format === 'stix') return json(iocStix(rows))
  return json({ count: rows.length, items: rows })
}

async function syndication(env, url, format) {
  const event = eventFilter(url, 'trustsight.alerts')
  if (event === null) return json({ error: 'bad_event' }, 400)
  const { items } = await listQuery(env, {
    ...pageFrom(url),
    q: url.searchParams.get('q'),
    event,
    day: url.searchParams.get('day') || undefined,
    from: url.searchParams.get('from') || undefined,
    to: url.searchParams.get('to') || undefined,
    campaign: url.searchParams.get('campaign') || undefined,
    maintainer: url.searchParams.get('maintainer') || undefined,
    rule: url.searchParams.get('rule') || undefined,
    over: url.searchParams.get('over') === '1',
    ioc: url.searchParams.get('ioc') === '1',
    campaigns: url.searchParams.get('campaigns') === '1',
    refusals: url.searchParams.get('refusals') === '1',
    limit: clampInt(url.searchParams.get('limit'), 50, 1, 100),
  })
  const baseUrl = new URL(url).origin
  if (format === 'atom') {
    return new Response(atomFeed(items, { baseUrl }), {
      headers: { 'content-type': 'application/atom+xml; charset=utf-8', 'cache-control': 'public, max-age=60', ...CORS },
    })
  }
  return new Response(JSON.stringify(jsonFeed(items, { baseUrl })),
    { headers: { 'content-type': 'application/feed+json; charset=utf-8', 'cache-control': 'public, max-age=60', ...CORS } })
}

async function checkpoints(env, url) {
  const limit = clampInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT)
  const { results } = await env.DB.prepare(
    `SELECT id, generated_at, from_rowid, through_rowid, count, previous_id,
            previous_root, root_hash, key_id, algorithm, signature
       FROM feed_checkpoints
      WHERE complete = 1
      ORDER BY generated_at DESC, id DESC
      LIMIT ?`
  ).bind(limit).all()
  return json({ count: (results || []).length, items: results || [] })
}

async function checkpointDetail(env, id) {
  const checkpointId = publicId(id)
  if (!checkpointId) return json({ error: 'bad_checkpoint' }, 400)
  const checkpoint = await env.DB.prepare(
    'SELECT * FROM feed_checkpoints WHERE id = ? AND complete = 1'
  ).bind(checkpointId).first()
  if (!checkpoint) return json({ error: 'not_found' }, 404)
  return json(checkpoint)
}

async function checkpointProof(env, id, url) {
  const checkpointId = publicId(id)
  if (!checkpointId) return json({ error: 'bad_checkpoint' }, 400)
  const slug = String(url.searchParams.get('slug') || '')
  if (!/^\d{4}-\d{2}-\d{2}\/\d{6}(?:-[A-Za-z0-9_-]+)?$/.test(slug)) {
    return json({ error: 'bad_slug' }, 400)
  }
  const checkpoint = await env.DB.prepare(
    'SELECT * FROM feed_checkpoints WHERE id = ? AND complete = 1'
  ).bind(checkpointId).first()
  if (!checkpoint) return json({ error: 'not_found' }, 404)
  const { results } = await env.DB.prepare(
    `SELECT slug, leaf_hash, leaf_index
       FROM feed_checkpoint_leaves
      WHERE checkpoint_id = ?
      ORDER BY leaf_index ASC`
  ).bind(checkpointId).all()
  const rows = results || []
  const index = rows.findIndex((row) => row.slug === slug)
  if (index < 0) return json({ error: 'not_in_checkpoint' }, 404)
  const { path, root } = await merkleProof(rows.map((row) => row.leaf_hash), index)
  return json({
    checkpoint_id: checkpointId,
    slug,
    leaf_hash: rows[index].leaf_hash,
    leaf_index: index,
    audit_path: path,
    root_hash: root,
    checkpoint_root: checkpoint.root_hash,
  })
}

function publicKeys(env) {
  const keys = []
  if (env.INGEST_KEY_ID && env.INGEST_PUBLIC_KEY) {
    keys.push({ id: env.INGEST_KEY_ID, public_key: env.INGEST_PUBLIC_KEY, current: true, purpose: 'ingest' })
  }
  if (env.INGEST_PREVIOUS_KEY_ID && env.INGEST_PUBLIC_KEY_PREVIOUS) {
    keys.push({ id: env.INGEST_PREVIOUS_KEY_ID, public_key: env.INGEST_PUBLIC_KEY_PREVIOUS, current: false, purpose: 'ingest' })
  }
  if (env.FEED_CHECKPOINT_KEY_ID && env.FEED_CHECKPOINT_PUBLIC_KEY) {
    keys.push({ id: env.FEED_CHECKPOINT_KEY_ID, public_key: env.FEED_CHECKPOINT_PUBLIC_KEY, current: true, purpose: 'checkpoint' })
  }
  if (env.FEED_CHECKPOINT_PREVIOUS_KEY_ID && env.FEED_CHECKPOINT_PUBLIC_KEY_PREVIOUS) {
    keys.push({ id: env.FEED_CHECKPOINT_PREVIOUS_KEY_ID, public_key: env.FEED_CHECKPOINT_PUBLIC_KEY_PREVIOUS, current: false, purpose: 'checkpoint' })
  }
  return json({ keys })
}

async function stats(env) {
  // feed_stats is maintained by triggers, so this is one row, not a scan.
  const row = await env.DB.prepare(
    `SELECT total, alive, first, last, alerts, over_threshold, ioc, impersonation,
            (SELECT MAX(time) FROM notifications
              WHERE event = 'trustsight.alerts') AS last_alert,
            (SELECT MAX(time) FROM notifications
              WHERE event = 'trustsight.heartbeat') AS last_alive
       FROM feed_stats WHERE id = 1`
  ).first() || {
    total: 0, alive: 0, first: null, last: null,
    last_alert: null, last_alive: null,
    alerts: 0, over_threshold: 0, ioc: 0, impersonation: 0,
  }
  // The analyzer version is the newest version any notification reports.
  // Reading only the latest alert made the stat stick at the pre-upgrade
  // version until the next alert, even though a heartbeat already proved the
  // watcher had restarted.  Keep both candidates so a payload without a
  // version cannot hide a newer one.
  const latestAlert = await env.DB.prepare(
    `SELECT time, payload FROM notifications WHERE event = 'trustsight.alerts'
      ORDER BY time DESC, rowid ASC LIMIT 1`
  ).first()
  const latestBeat = await env.DB.prepare(
    `SELECT time, payload FROM notifications WHERE event = 'trustsight.heartbeat'
      ORDER BY time DESC, rowid ASC LIMIT 1`
  ).first()
  const versions = [latestAlert, latestBeat]
    .map((entry) => ({
      time: Number(entry && entry.time) || 0,
      version: extractToolVersion(entry && entry.payload),
    }))
    .filter((entry) => entry.version)
    .sort((a, b) => b.time - a.time)
  if (versions.length) row.tool_version = versions[0].version
  const counts = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM campaign_events) AS campaigns,
            (SELECT COUNT(*) FROM maintainer_events) AS maintainers,
            (SELECT COUNT(*) FROM ioc_events) AS ioc_events,
            (SELECT COUNT(*) FROM feed_checkpoints WHERE complete = 1) AS checkpoints`
  ).first()
  return json({ ...row, ...(counts || {}) })
}

/** The tool_version a stored payload JSON carries, when it has one. */
function extractToolVersion(payloadJson) {
  try {
    const payload = JSON.parse(payloadJson || '{}')
    return payload && typeof payload.tool_version === 'string' && payload.tool_version
  } catch {
    return false
  }
}

function index() {
  return json({ name: 'trustsight-feed', endpoints: ENDPOINTS })
}

/** The latest AUR commit as a unified diff, so the page can show what was removed. */
async function diff(env, url, name) {
  if (!PACKAGE_RE.test(name)) return json({ error: 'bad_package' }, 400)
  const done = (text) => new Response(JSON.stringify({ package: name, diff: text }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600', ...CORS },
  })

  const cached = await cacheRead(env, 'diff', name, '')
  if (cached && !cached.stale) return done(cached.content)

  // A split package's repository is its pkgbase, not its pkgname.
  const repo = await resolvePkgbase(env, name)
  let res
  try {
    res = await fetch(`${AUR_PATCH}?h=${encodeURIComponent(repo)}`, {
      headers: { 'user-agent': 'trustsight-feed/1.0' },
    })
  } catch {
    return cached ? done(cached.content) : json({ error: 'upstream_unreachable' }, 502)
  }
  if (!res.ok) return cached ? done(cached.content) : json({ error: `upstream_${res.status}` }, 502)
  const text = await res.text()
  if (text.length > MAX_DIFF_BYTES) return json({ error: 'too_large', package: name }, 413)
  await cacheWrite(env, 'diff', name, '', text, '')
  return done(text)
}

/** The current AUR maintainer for a batch of packages, from the AUR RPC. */
async function fetchMaintainers(nameList) {
  const found = {}
  for (let i = 0; i < nameList.length; i += 50) {
    const params = nameList.slice(i, i + 50).map((n) => `arg[]=${encodeURIComponent(n)}`).join('&')
    try {
      const res = await fetch(`${AUR_RPC_INFO}?${params}`, { headers: { 'user-agent': 'trustsight-feed/1.0' } })
      if (!res.ok) continue
      const body = await res.json()
      for (const row of body.results || []) found[row.Name] = row.Maintainer || ''
    } catch {
      /* a package with no RPC answer is simply left unknown */
    }
  }
  return found
}

async function maintainers(env, url) {
  const raw = url.searchParams.get('packages') || ''
  const names = [...new Set(raw.split(',').map((s) => s.trim()).filter((n) => PACKAGE_RE.test(n)))].slice(0, 100)
  if (!names.length) return json({ maintainers: {} })

  const now = Math.floor(Date.now() / 1000)
  const result = {}
  const missing = []
  const rows = await env.DB.prepare(
    `SELECT package, maintainer, fetched_at FROM maintainer_cache WHERE package IN (${names.map(() => '?').join(',')})`
  ).bind(...names).all()
  const cached = new Map((rows.results || []).map((r) => [r.package, r]))
  for (const name of names) {
    const row = cached.get(name)
    if (row && now - row.fetched_at <= MAINTAINER_CACHE_TTL) result[name] = row.maintainer
    else missing.push(name)
  }
  if (missing.length) {
    const fetched = await fetchMaintainers(missing)
    for (const name of missing) result[name] = fetched[name] || ''
    // One multi-row upsert instead of one write per package.
    if (missing.length) {
      const values = missing.map((name) => [name, result[name], now])
      await env.DB.prepare(
        `INSERT INTO maintainer_cache (package, maintainer, fetched_at)
         VALUES ${values.map(() => '(?, ?, ?)').join(', ')}
         ON CONFLICT(package) DO UPDATE SET
           maintainer = excluded.maintainer, fetched_at = excluded.fetched_at`
      ).bind(...values.flat()).run()
    }
  }
  return new Response(JSON.stringify({ maintainers: result }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600', ...CORS },
  })
}

// The AUR artifact the analysis read. The feed serves it back, unmodified, so
// the detail page can show the source with the flagged lines highlighted. The
// host is fixed (never a package-declared URL) and the size is capped.
const AUR_CGIT = 'https://aur.archlinux.org/cgit/aur.git/plain'
const AUR_TREE = 'https://aur.archlinux.org/cgit/aur.git/tree/'
const AUR_PATCH = 'https://aur.archlinux.org/cgit/aur.git/patch/'
const AUR_RPC_INFO = 'https://aur.archlinux.org/rpc/v5/info'
const MAX_SOURCE_BYTES = 512 * 1024
const MAX_DIFF_BYTES = 1024 * 1024
//: How long a fetched AUR file is served from the store before it is fetched
//: again. A page view never reaches the AUR; only the first view after this.
const SOURCE_CACHE_TTL = 86400
const MAINTAINER_CACHE_TTL = 86400

async function cacheRead(env, kind, name, file) {
  const row = await env.DB.prepare(
    'SELECT content, actual_file, fetched_at FROM source_cache WHERE package = ? AND file = ? AND kind = ?'
  ).bind(name, file, kind).first()
  if (!row) return null
  const age = Math.floor(Date.now() / 1000) - row.fetched_at
  return { content: row.content, actualFile: row.actual_file, stale: age > SOURCE_CACHE_TTL }
}

async function cacheWrite(env, kind, name, file, content, actualFile) {
  await env.DB.prepare(
    `INSERT INTO source_cache (package, file, kind, actual_file, content, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(package, file, kind) DO UPDATE SET
       content = excluded.content, actual_file = excluded.actual_file, fetched_at = excluded.fetched_at`
  ).bind(name, file, kind, actualFile || '', content, Math.floor(Date.now() / 1000)).run()
}
const PACKAGE_RE = /^[A-Za-z0-9@._+-]{1,255}$/
const SOURCE_FILE_RE = /^[A-Za-z0-9@._+/-]{1,255}$/

/** Fetch one file from the AUR repository. `{ text }`, `{ missing }` or `{ error }`. */
async function fetchAurFile(name, file) {
  let res
  try {
    res = await fetch(`${AUR_CGIT}/${encodeURIComponent(file)}?h=${encodeURIComponent(name)}`, {
      headers: { 'user-agent': 'trustsight-feed/1.0' },
    })
  } catch {
    return { error: 'upstream_unreachable' }
  }
  if (res.status === 404) return { missing: true }
  if (!res.ok) return { error: `upstream_${res.status}` }
  const text = await res.text()
  if (text.length > MAX_SOURCE_BYTES) return { error: 'too_large' }
  return { text }
}

/** The file names in the repository, read from the cgit tree listing. */
async function fetchRepoFiles(name) {
  try {
    const res = await fetch(`${AUR_TREE}?h=${encodeURIComponent(name)}`, {
      headers: { 'user-agent': 'trustsight-feed/1.0' },
    })
    if (!res.ok) return []
    const html = await res.text()
    const names = [...html.matchAll(/\/cgit\/aur\.git\/tree\/([^'"?]+)\?h=/g)].map((m) => safeDecode(m[1])).filter(Boolean)
    return [...new Set(names)]
  } catch {
    return []
  }
}

/**
 * The AUR pkgbase for a package name. A split package's pkgname differs from
 * its repository name (the pkgbase), and cgit addresses the repository by
 * pkgbase, so `h=<pkgname>` returns 404 for every package of a split. The
 * mapping is read from the AUR RPC and cached.
 */
async function resolvePkgbase(env, name) {
  const now = Math.floor(Date.now() / 1000)
  const row = await env.DB.prepare('SELECT pkgbase, fetched_at FROM pkgbase_cache WHERE name = ?').bind(name).first()
  if (row && now - row.fetched_at <= MAINTAINER_CACHE_TTL) return row.pkgbase
  let pkgbase = name
  try {
    const res = await fetch(`${AUR_RPC_INFO}?arg[]=${encodeURIComponent(name)}`, {
      headers: { 'user-agent': 'trustsight-feed/1.0' },
    })
    if (res.ok) {
      const body = await res.json()
      const entry = (body.results || [])[0]
      if (entry && entry.PackageBase) pkgbase = entry.PackageBase
    }
  } catch {
    /* keep the name */
  }
  await env.DB.prepare(
    `INSERT INTO pkgbase_cache (name, pkgbase, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET pkgbase = excluded.pkgbase, fetched_at = excluded.fetched_at`
  ).bind(name, pkgbase, now).run()
  return pkgbase
}

function sourceResponse(name, file, content, requested) {  const body = { package: name, file, content }
  if (requested && requested !== file) body.requested = requested
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600', ...CORS },
  })
}

async function source(env, url, name) {
  if (!PACKAGE_RE.test(name)) return json({ error: 'bad_package' }, 400)
  const file = url.searchParams.get('file') || 'PKGBUILD'
  if (!SOURCE_FILE_RE.test(file) || file.includes('..') || file.startsWith('/')) {
    return json({ error: 'bad_file' }, 400)
  }

  // Serve from the store first, so a page view never reaches the AUR.
  const cached = await cacheRead(env, 'source', name, file)
  if (cached && !cached.stale) return sourceResponse(name, cached.actualFile || file, cached.content, file)

  const repo = await resolvePkgbase(env, name)
  const direct = await fetchAurFile(repo, file)
  if (direct.text !== undefined) {
    await cacheWrite(env, 'source', name, file, direct.text, file)
    return sourceResponse(name, file, direct.text)
  }
  if (direct.error) {
    if (cached) return sourceResponse(name, cached.actualFile || file, cached.content, file)
    return json({ error: direct.error }, 502)
  }

  // Missing: a finding may name a file differently than the repository does,
  // for example `<pkgname>.install` where the repository holds a differently
  // named `.install`. Offer the repository's files and serve the same-extension
  // one, so the source view still opens.
  const available = await fetchRepoFiles(repo)
  const dot = file.lastIndexOf('.')
  const ext = dot > 0 ? file.slice(dot) : ''
  const match = ext ? available.find((candidate) => candidate.endsWith(ext) && candidate !== file) : null
  if (match) {
    const alt = await fetchAurFile(repo, match)
    if (alt.text !== undefined) {
      await cacheWrite(env, 'source', name, file, alt.text, match)
      return sourceResponse(name, match, alt.text, file)
    }
  }
  if (cached) return sourceResponse(name, cached.actualFile || file, cached.content, file)
  return json({ error: 'not_found', package: name, file, available }, 404)
}

/** Dispatch an API request, or return null when the path is not ours. */
async function handleApiUnsafe(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method_not_allowed' }, 405)
  }

  const path = url.pathname.replace(/\/+$/, '') || '/api'
  if (path === '/api/index.json') return index()
  // The reference page lives in the SPA at /api; send both docs spellings there.
  if (path === '/api/docs' || path === '/api/reference') return redirect('/api')
  if (path === '/api/openapi.json') return json(openapiSpec)
  if (path === '/api/feed.atom') return syndication(env, url, 'atom')
  if (path === '/api/feed.json') return syndication(env, url, 'json')
  if (path === '/api/keys') return publicKeys(env)
  if (path === '/api/checkpoints') return checkpoints(env, url)
  if (path === '/api/campaigns') return campaigns(env, url)
  if (path === '/api/triggers') return triggers(env, url)
  if (path === '/api/rules') return rules(env, url)
  if (path === '/api/iocs') return iocs(env, url)
  if (path === '/api/feed') return feed(env, url)
  if (path === '/api/stats') return stats(env)
  if (path === '/api/latest') return latestOne(env)

  let match
  if ((match = path.match(/^\/api\/latest\/(\d+)$/))) {
    return latestN(env, url, clampInt(match[1], 1, 1, MAX_LIMIT))
  }
  if ((match = path.match(/^\/api\/date\/([0-9-]+)\/([^/]+)$/))) {
    const timeframe = match[2] ? safeDecode(match[2]) : null
    if (match[2] && timeframe === null) return json({ error: 'bad_path' }, 400)
    return byDate(env, url, match[1], timeframe)
  }
  if ((match = path.match(/^\/api\/date\/([0-9-]+)$/))) {
    return byDate(env, url, match[1], null)
  }
  if ((match = path.match(/^\/api\/package\/(.+)\/history$/))) {
    const name = safeDecode(match[1])
    if (name === null) return json({ error: 'bad_path' }, 400)
    return packageHistoryResponse(env, name)
  }
  if ((match = path.match(/^\/api\/package\/(.+)$/))) {
    const term = safeDecode(match[1])
    if (term === null) return json({ error: 'bad_path' }, 400)
    return bySearch(env, url, term)
  }
  if ((match = path.match(/^\/api\/checkpoints\/([^/]+)\/proof$/))) {
    const id = safeDecode(match[1])
    if (id === null) return json({ error: 'bad_path' }, 400)
    return checkpointProof(env, id, url)
  }
  if ((match = path.match(/^\/api\/checkpoints\/([^/]+)$/))) {
    const id = safeDecode(match[1])
    if (id === null) return json({ error: 'bad_path' }, 400)
    return checkpointDetail(env, id)
  }
  if ((match = path.match(/^\/api\/campaign\/(.+)$/))) {
    const id = safeDecode(match[1])
    if (id === null) return json({ error: 'bad_path' }, 400)
    return campaignDetail(env, id)
  }
  if ((match = path.match(/^\/api\/maintainer\/(.+)$/))) {
    const name = safeDecode(match[1])
    if (name === null) return json({ error: 'bad_path' }, 400)
    return maintainerDetail(env, name, url)
  }
  if ((match = path.match(/^\/api\/rule\/([^/]+)\/triggers$/))) {
    const id = safeDecode(match[1])
    if (id === null) return json({ error: 'bad_path' }, 400)
    return triggers(env, url, id)
  }
  if ((match = path.match(/^\/api\/rule\/(.+)$/))) {
    return bySearch(env, url, decodeURIComponent(match[1]))
  }
  if ((match = path.match(/^\/api\/source\/(.+)$/))) {
    const name = safeDecode(match[1])
    if (name === null) return json({ error: 'bad_path' }, 400)
    return source(env, url, name)
  }
  if ((match = path.match(/^\/api\/diff\/(.+)$/))) {
    const name = safeDecode(match[1])
    if (name === null) return json({ error: 'bad_path' }, 400)
    return diff(env, url, name)
  }
  if (path === '/api/maintainers') return maintainers(env, url)
  if (path.startsWith('/api/messages/')) {
    const slug = safeDecode(path.slice('/api/messages/'.length))
    if (slug === null) return json({ error: 'bad_path' }, 400)
    if (!slug) return json({ error: 'not_found' }, 404)
    return message(env, slug)
  }

  return json({ error: 'not_found', endpoints: ENDPOINTS }, 404)
}

export async function handleApi(request, env, url) {
  try {
    return await handleApiUnsafe(request, env, url)
  } catch {
    return json({ error: 'internal' }, 500)
  }
}
