import { handleApi } from './api.js'
import { pollNtfy } from './poller.js'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) {
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
