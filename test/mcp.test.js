import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const ENDPOINT = 'https://example.com/mcp'

function post(payload, headers = {}) {
  return SELF.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}

async function rpc(payload) {
  const response = await post(payload)
  return { status: response.status, body: await response.json(), headers: response.headers }
}

describe('MCP bridge', () => {
  it('answers OPTIONS with the CORS preflight', async () => {
    const response = await SELF.fetch(ENDPOINT, { method: 'OPTIONS' })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-methods')).toContain('POST')
  })

  it('refuses GET with the transport it actually speaks', async () => {
    const response = await SELF.fetch(ENDPOINT)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toContain('POST')
    expect((await response.json()).error).toMatch(/POST/)
  })

  it('negotiates a supported protocol version and falls back otherwise', async () => {
    const supported = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    })
    expect(supported.body.result.protocolVersion).toBe('2025-03-26')
    expect(supported.body.result.serverInfo.name).toBe('trustsight-watcher')
    expect(supported.body.result.capabilities.tools).toBeDefined()

    const unknown = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    })
    expect(unknown.body.result.protocolVersion).toBe('2025-06-18')
  })

  it('lists the four read-only tools with schemas', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      'search-alerts',
      'latest-alerts',
      'package-history',
      'rule-triggers',
    ])
    for (const tool of body.result.tools) {
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('runs a tool against the stored feed', async () => {
    const { body } = await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'search-alerts', arguments: { q: 'nothing-matches-this', limit: 1 } },
    })
    const result = body.result
    expect(result.isError).toBeUndefined()
    expect(result.content[0].type).toBe('text')
    expect(() => JSON.parse(result.content[0].text)).not.toThrow()
  })

  it('reports an unknown tool as a tool error, not a transport error', async () => {
    const { status, body } = await rpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'delete-everything', arguments: {} },
    })
    expect(status).toBe(200)
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toMatch(/unknown tool/)
  })

  it('rejects an unknown method with JSON-RPC -32601', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/execute' })
    expect(body.error.code).toBe(-32601)
  })

  it('rejects malformed bodies without a 500', async () => {
    const parse = await post('{not json')
    expect(parse.status).toBe(400)
    expect((await parse.json()).error.code).toBe(-32700)

    const invalid = await post({ id: 7, method: 'tools/list' })
    expect(invalid.status).toBe(400)
    expect((await invalid.json()).error.code).toBe(-32600)
  })

  it('acknowledges a notification and answers a batch', async () => {
    const notification = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(notification.status).toBe(202)

    const batch = await rpc([
      { jsonrpc: '2.0', id: 8, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ])
    expect(batch.body).toHaveLength(1)
    expect(batch.body[0].id).toBe(8)
  })

  it('advertises the canonical endpoint on the data host', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 9, method: 'server/discover' })
    expect(body.result.transports[0].url).toBe('https://watcher.trustsight.org/mcp')
  })
})
