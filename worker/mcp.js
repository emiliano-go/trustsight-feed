// Read-only MCP bridge over the watcher feed.
//
// The bridge lives beside the API it serves, not in the marketing site: the
// tool schemas and the routes they call then move together, and a tool call is
// an in-process `handleApi` invocation rather than a second network hop. It is
// stateless — no session id — and every request is a single JSON-RPC exchange.
// There is no write surface.

import { handleApi } from './api.js'

const ORIGIN = 'https://watcher.trustsight.org'
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const DEFAULT_PROTOCOL = '2025-06-18'
const MAX_TEXT = 80_000

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, MCP-Protocol-Version',
}

const TOOLS = [
  {
    name: 'search-alerts',
    description: 'Search the public TrustSight watcher feed for alerts.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
      required: ['q'],
      additionalProperties: false,
    },
  },
  {
    name: 'latest-alerts',
    description: 'Return the most recent TrustSight watcher alerts.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'package-history',
    description:
      'Return every stored alert that names an AUR package, with rule firings and version transitions.',
    inputSchema: {
      type: 'object',
      properties: { package: { type: 'string', minLength: 1 } },
      required: ['package'],
      additionalProperties: false,
    },
  },
  {
    name: 'rule-triggers',
    description: 'Return normalized triggers for one TrustSight rule id.',
    inputSchema: {
      type: 'object',
      properties: {
        rule: { type: 'string', pattern: '^[A-Z][0-9]{3}$' },
        since: { type: 'integer', minimum: 0 },
      },
      required: ['rule'],
      additionalProperties: false,
    },
  },
]

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  })
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function textResult(text, isError = false) {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  }
}

// One API read, dispatched exactly as an external request would be, without
// leaving the Worker. `handleApi` owns the routing; no path logic is copied
// here.
async function api(path, env) {
  const url = new URL(ORIGIN + path)
  const request = new Request(url, { headers: { accept: 'application/json' } })
  const response = await handleApi(request, env, url)
  if (!response.ok) throw new Error(`watcher API returned HTTP ${response.status}`)
  return await response.json()
}

function assertObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('arguments must be an object')
  }
  return value
}

async function callTool(name, rawArgs, env) {
  const args = assertObject(rawArgs || {})

  if (name === 'search-alerts') {
    const q = String(args.q || '').trim()
    if (!q) throw new Error('q is required')
    const limit = Math.min(50, Math.max(1, Number(args.limit) || 10))
    const data = await api(`/api/feed?q=${encodeURIComponent(q)}&limit=${limit}`, env)
    return textResult(JSON.stringify(data, null, 2).slice(0, MAX_TEXT))
  }

  if (name === 'latest-alerts') {
    const limit = Math.min(20, Math.max(1, Number(args.limit) || 5))
    const data = await api(`/api/latest/${limit}`, env)
    return textResult(JSON.stringify(data, null, 2).slice(0, MAX_TEXT))
  }

  if (name === 'package-history') {
    const pkg = String(args.package || '').trim()
    if (!pkg) throw new Error('package is required')
    const data = await api(`/api/package/${encodeURIComponent(pkg)}/history`, env)
    return textResult(JSON.stringify(data, null, 2).slice(0, MAX_TEXT))
  }

  if (name === 'rule-triggers') {
    const rule = String(args.rule || '').trim().toUpperCase()
    if (!/^[A-Z][0-9]{3}$/.test(rule)) {
      throw new Error('rule must look like H003')
    }
    const since = Number(args.since)
    const suffix = Number.isFinite(since) && since >= 0 ? `?since=${since}` : ''
    const data = await api(`/api/rule/${encodeURIComponent(rule)}/triggers${suffix}`, env)
    return textResult(JSON.stringify(data, null, 2).slice(0, MAX_TEXT))
  }

  throw new Error(`unknown tool: ${name}`)
}

async function dispatch(message, env) {
  const { id, method, params } = message
  const isNotification = id === undefined || id === null

  if (method === 'initialize') {
    const requested = params && params.protocolVersion
    const protocolVersion = PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : DEFAULT_PROTOCOL
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'trustsight-watcher', version: '1.0.0' },
        instructions:
          'Read-only access to the TrustSight AUR watcher. Findings are evidence, not a safety verdict.',
      },
    }
  }

  if (isNotification) return null

  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
  }

  if (method === 'tools/call') {
    const name = params && params.name
    try {
      const result = await callTool(name, params && params.arguments, env)
      return { jsonrpc: '2.0', id, result }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        result: textResult(String(error.message || error), true),
      }
    }
  }

  if (method === 'resources/list') {
    return { jsonrpc: '2.0', id, result: { resources: [] } }
  }

  if (method === 'prompts/list') {
    return { jsonrpc: '2.0', id, result: { prompts: [] } }
  }

  if (method === 'server/discover') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        serverInfo: { name: 'trustsight-watcher', version: '1.0.0' },
        supportedVersions: PROTOCOL_VERSIONS,
        transports: [{ type: 'streamable-http', url: `${ORIGIN}/mcp` }],
      },
    }
  }

  return rpcError(id, -32601, `method not found: ${method}`)
}

export function mcpOptions() {
  return new Response(null, { status: 204, headers: CORS })
}

export async function handleMcp(request, env) {
  if (request.method === 'OPTIONS') return mcpOptions()

  if (request.method === 'GET' || request.method === 'HEAD') {
    return json(
      { error: 'This is a Streamable HTTP MCP endpoint. Send JSON-RPC over POST.' },
      405,
      { Allow: 'POST, OPTIONS' },
    )
  }

  if (request.method !== 'POST') {
    return json(rpcError(null, -32600, 'invalid request'), 405, { Allow: 'POST, OPTIONS' })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return json(rpcError(null, -32700, 'parse error'), 400)
  }

  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map((message) => dispatch(message, env)))).filter(Boolean)
    return responses.length
      ? json(responses)
      : new Response(null, { status: 202, headers: CORS })
  }

  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return json(rpcError(body && body.id, -32600, 'invalid request'), 400)
  }

  const response = await dispatch(body, env)
  // A notification carries no id and expects no reply, only an acknowledgement.
  if (response === null) return new Response(null, { status: 202, headers: CORS })
  return json(response)
}
