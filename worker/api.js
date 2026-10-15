// Read API over the D1 store. Public data, so responses are CORS-open for
// anyone who wants to consume the feed from another tool.

import { ftsQuery, summarize } from './lib.js'
import { openapiSpec } from './openapi.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const SECONDS_PER_DAY = 86400

const ENDPOINTS = [
  'GET /api (reference page)',
  'GET /api/index.json',
  'GET /api/docs (redirects to /api)',
  'GET /api/openapi.json',
  'GET /api/feed?q=&event=&day=&from=&to=&limit=&before=&beforeRow=',
  'GET /api/latest',
  'GET /api/latest/{n}',
  'GET /api/date/{YYYY-MM-DD}',
  'GET /api/date/{YYYY-MM-DD}/{timeframe}',
  'GET /api/package/{name}',
  'GET /api/rule/{id}',
  'GET /api/messages/{slug}',
  'GET /api/source/{package}?file=PKGBUILD',
  'GET /api/diff/{package}',
  'GET /api/maintainers?packages=a,b,c',
  'GET /api/stats',
]

// Timeframes: `HH` (one hour), `HH-HH` (whole hours), `HHMM-HHMM` (a range).
const TIMEFRAME_RE = /^(\d{2})(\d{2})?-(\d{2})(\d{2})?$/
const HOUR_RE = /^(\d{2})$/

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'content-type',
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

/** One paginated query shared by every list endpoint. */
async function listQuery(env, options = {}) {
  const {
    q, event = 'all', day, from, to, beforeTime, beforeRow,
    limit = DEFAULT_LIMIT,
  } = options
  const fts = ftsQuery(q)
  const where = []
  const params = []

  if (fts) { where.push('f.notifications_fts MATCH ?'); params.push(fts) }
  if (event && event !== 'all') { where.push('n.event = ?'); params.push(event) }
  if (day) { where.push('n.day = ?'); params.push(day) }
  if (from !== undefined && from !== null) { where.push('n.time >= ?'); params.push(from) }
  if (to !== undefined && to !== null) { where.push('n.time <= ?'); params.push(to) }
  if (beforeTime && beforeRow) {
    where.push('(n.time < ? OR (n.time = ? AND n.rowid < ?))')
    params.push(beforeTime, beforeTime, beforeRow)
  }

  const fromClause = fts ? 'notifications n JOIN notifications_fts f ON f.rowid = n.rowid' : 'notifications n'
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const { results } = await env.DB.prepare(
    `SELECT n.*, n.rowid AS _rowid FROM ${fromClause} ${whereClause} ORDER BY n.time DESC, n.rowid DESC LIMIT ?`
  )
    .bind(...params, limit)
    .all()

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

async function getBySlug(env, slug) {
  const row = await env.DB.prepare('SELECT * FROM notifications WHERE slug = ?').bind(slug).first()
  if (!row) return null
  let payload = {}
  try { payload = JSON.parse(row.payload || '{}') } catch { /* keep {} */ }
  return { ...summarize(row), payload, message_raw: row.message_raw }
}

async function feed(env, url) {
  return listResponse(env, url, {
    query: { source: 'feed' },
    q: url.searchParams.get('q'),
    event: url.searchParams.get('event') || 'trustsight.alerts',
    day: url.searchParams.get('day') || undefined,
    from: url.searchParams.get('from') || undefined,
    to: url.searchParams.get('to') || undefined,
  })
}

async function latestOne(env, url) {
  const { items } = await listQuery(env, { ...pageFrom(url), limit: 1 })
  if (!items.length) return json({ error: 'empty' }, 404)
  const full = await getBySlug(env, items[0].slug)
  return json({ query: { source: 'latest', limit: 1 }, item: full })
}

async function latestN(env, url, n) {
  return listResponse(env, url, { query: { source: 'latest', limit: n }, limit: n })
}

async function byDate(env, url, date, timeframe) {
  const window = dateWindow(date, timeframe)
  if (!window) return json({ error: 'bad_date_or_timeframe', date, timeframe }, 400)
  return listResponse(env, url, {
    query: { source: 'date', date, timeframe: timeframe || null },
    from: window.from,
    to: window.to,
    event: url.searchParams.get('event') || 'all',
  })
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

async function stats(env) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            MIN(time) AS first,
            MAX(time) AS last,
            COALESCE(SUM(n_alerts), 0) AS alerts,
            COALESCE(SUM(n_over_threshold), 0) AS over_threshold,
            COALESCE(SUM(n_ioc), 0) AS ioc,
            COALESCE(SUM(n_impersonation), 0) AS impersonation
       FROM notifications
      WHERE event = 'trustsight.alerts'`
  ).first()
  return json(row || {})
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
    for (const name of missing) {
      const value = fetched[name] || ''
      result[name] = value
      await env.DB.prepare(
        `INSERT INTO maintainer_cache (package, maintainer, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(package) DO UPDATE SET maintainer = excluded.maintainer, fetched_at = excluded.fetched_at`
      ).bind(name, value, now).run()
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
    const names = [...html.matchAll(/\/cgit\/aur\.git\/tree\/([^'"?]+)\?h=/g)].map((m) => decodeURIComponent(m[1]))
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
export async function handleApi(request, env, url) {
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
  if (path === '/api/feed') return feed(env, url)
  if (path === '/api/stats') return stats(env)
  if (path === '/api/latest') return latestOne(env, url)

  let match
  if ((match = path.match(/^\/api\/latest\/(\d+)$/))) {
    return latestN(env, url, clampInt(match[1], 1, 1, MAX_LIMIT))
  }
  if ((match = path.match(/^\/api\/date\/([0-9-]+)\/([^/]+)$/))) {
    return byDate(env, url, match[1], decodeURIComponent(match[2]))
  }
  if ((match = path.match(/^\/api\/date\/([0-9-]+)$/))) {
    return byDate(env, url, match[1], null)
  }
  if ((match = path.match(/^\/api\/package\/(.+)$/))) {
    return bySearch(env, url, decodeURIComponent(match[1]))
  }
  if ((match = path.match(/^\/api\/rule\/(.+)$/))) {
    return bySearch(env, url, decodeURIComponent(match[1]))
  }
  if ((match = path.match(/^\/api\/source\/(.+)$/))) {
    return source(env, url, decodeURIComponent(match[1]))
  }
  if ((match = path.match(/^\/api\/diff\/(.+)$/))) {
    return diff(env, url, decodeURIComponent(match[1]))
  }
  if (path === '/api/maintainers') return maintainers(env, url)
  if (path.startsWith('/api/messages/')) {
    const slug = decodeURIComponent(path.slice('/api/messages/'.length))
    if (!slug) return json({ error: 'not_found' }, 404)
    return message(env, slug)
  }

  return json({ error: 'not_found', endpoints: ENDPOINTS }, 404)
}
