import { handleApi } from './api.js'
import { ingestDocument, MAX_BODY_BYTES } from './ingest.js'

function rateLimited() {
  return new Response(JSON.stringify({ error: 'rate_limited' }), {
    status: 429,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'retry-after': '60',
      'access-control-allow-origin': '*',
    },
  })
}

function redirect(location) {
  return new Response(null, {
    status: 308,
    headers: { location, 'cache-control': 'public, max-age=3600' },
  })
}

// Read responses served from the edge cache, so repeated polls (the feed page
// asks for stats every 30 seconds) do not become repeated D1 queries.  The
// first request after a TTL pays for the query; the rest are cache hits.
const CACHE_TTLS = [
  [/^\/api\/stats$/, 60],
  [/^\/api\/feed$/, 30],
  [/^\/api\/latest(?:\/\d+)?$/, 30],
  [/^\/api\/date\//, 60],
  [/^\/api\/package\/[^/]+\/history$/, 60],
  [/^\/api\/package\//, 30],
  [/^\/api\/rule\//, 30],
  [/^\/api\/messages\//, 300],
  [/^\/api\/maintainers$/, 3600],
  [/^\/api\/source\//, 3600],
  [/^\/api\/diff\//, 3600],
  [/^\/api\/index\.json$/, 86400],
  [/^\/api\/openapi\.json$/, 86400],
]

function cacheTtl(pathname) {
  for (const [pattern, ttl] of CACHE_TTLS) {
    if (pattern.test(pathname)) return ttl
  }
  return 0
}

function apiCache() {
  return typeof caches !== 'undefined' && caches.default ? caches.default : null
}

/** Search routes are the only ones that can scan a fuzzy window. */
function isSearchRequest(url) {
  if (url.pathname.startsWith('/api/package/') || url.pathname.startsWith('/api/rule/')) return true
  return url.pathname === '/api/feed' && Boolean((url.searchParams.get('q') || '').trim())
}

async function cachedApi(request, env, ctx, url) {
  const ttl = cacheTtl(url.pathname)
  const cache = apiCache()
  if (!ttl || !cache || env.API_CACHE === 'off' || request.method !== 'GET') {
    return handleApi(request, env, url)
  }
  const key = new Request(url.toString())
  const hit = await cache.match(key)
  if (hit) return hit
  const response = await handleApi(request, env, url)
  if (response && response.status === 200) {
    const stored = new Response(response.body, response)
    stored.headers.set('cache-control', `public, max-age=${ttl}`)
    if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(key, stored.clone()))
    return stored
  }
  return response
}

// Root spellings of the API resources. Without this, /feed and /latest fall
// through to the SPA and silently render the home page.
const ROOT_ALIASES = ['/feed', '/latest', '/date', '/package', '/rule', '/stats', '/messages']

// A cheap liveness and readiness check. Not rate limited, so a monitor is
// never throttled, and no-store so it is always current.
async function health(env) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  try {
    const schema = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind('schema').first()
    const last = await env.DB.prepare('SELECT MAX(time) AS t FROM notifications').first()
    return new Response(JSON.stringify({
      status: 'ok',
      time: new Date().toISOString(),
      db: 'ok',
      schema: schema ? schema.value : null,
      last: last ? last.t : null,
    }), { status: 200, headers })
  } catch (err) {
    return new Response(JSON.stringify({
      status: 'degraded',
      time: new Date().toISOString(),
      db: 'error',
      error: String(err && err.message ? err.message : err),
    }), { status: 503, headers })
  }
}

/** POST /api/ingest: verify the Ed25519 signature, then store the document. */
async function ingest(request, env) {
  const json = { 'content-type': 'application/json; charset=utf-8' }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: json })
  }
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: 'too_large' }), { status: 413, headers: json })
  }
  const result = await ingestDocument(env, raw, request.headers)
  const status = result.status || (result.ok ? 200 : 401)
  const body = result.ok ? { stored: result.stored, id: result.id } : { error: result.error }
  return new Response(JSON.stringify(body), { status, headers: json })
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname === '/health' || url.pathname === '/healthz') return health(env)

    // The bare /api path is the HTML reference page, served by the SPA; its
    // trailing-slash spelling goes to the same place.
    if (url.pathname === '/api') return env.ASSETS.fetch(request)
    if (url.pathname === '/api/') return redirect('/api')

    // Short API spellings at the root redirect to their /api equivalent.
    if (ROOT_ALIASES.some((base) => url.pathname === base || url.pathname.startsWith(`${base}/`))) {
      return redirect(`/api${url.pathname}${url.search}`)
    }

    if (url.pathname.startsWith('/api/')) {
      // Rate limit before any D1 work. 120 requests a minute per client; the
      // binding is absent under the test harness, where it is not needed.
      if (env.API_LIMITER) {
        const key = request.headers.get('CF-Connecting-IP') || 'anonymous'
        const { success } = await env.API_LIMITER.limit({ key })
        if (!success) return rateLimited()
      }
      // A tighter cap on the routes that can trigger the typo fallback, so a
      // single client cannot turn a miss into a large D1 scan.
      if (env.SEARCH_LIMITER && isSearchRequest(url)) {
        const key = `search:${request.headers.get('CF-Connecting-IP') || 'anonymous'}`
        const { success } = await env.SEARCH_LIMITER.limit({ key })
        if (!success) return rateLimited()
      }
      // The signed direct-ingest route. The watcher POSTs the alert document
      // here (outbound), so the feed never polls ntfy.
      if (url.pathname === '/api/ingest') return ingest(request, env)
      const response = await cachedApi(request, env, ctx, url)
      if (response) return response
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    // Static frontend; `not_found_handling: single-page-application` turns
    // the detail routes (/<date>/<time>/) into the app shell.
    return env.ASSETS.fetch(request)
  },
}
