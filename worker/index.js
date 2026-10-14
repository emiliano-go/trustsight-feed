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

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // The bare /api path is the HTML reference page, served by the SPA.
    if (url.pathname === '/api') return env.ASSETS.fetch(request)

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
