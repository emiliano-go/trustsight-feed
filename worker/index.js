import { handleApi } from './api.js'
import { pollNtfy } from './poller.js'

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

export default {
  async fetch(request, env) {
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
      const response = await handleApi(request, env, url)
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

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(pollNtfy(env))
  },
}
