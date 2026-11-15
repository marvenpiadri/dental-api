// Drives the Worker with the official MCP client over real Streamable HTTP framing (initialize -> initialized -> tools/*), stateless mode.
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { handle, type Sql } from '../src/index'

const TOKEN = 'k'.repeat(32), env = { TIDB_DATABASE_URL: 'u', MCP_TOKEN: TOKEN }
const sql: Sql = { rows: async (q) => [{ q: q.slice(0, 20) }], run: async () => 0 }
const viaWorker = ((url: string | URL, init?: RequestInit) => handle(new Request(url, init), env, sql)) as typeof fetch

async function client(token: string | null) {
  const c = new Client({ name: 'claude-ai', version: '1' })
  await c.connect(new StreamableHTTPClientTransport(new URL('https://worker.test/mcp'), { fetch: viaWorker, requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} } }))
  return c
}
describe('Streamable HTTP at /mcp', () => {
  it('a real MCP client can initialize, list tools and call list_tables / describe_table / query_read', async () => {
    const c = await client(TOKEN)
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(['describe_table', 'execute_write', 'list_tables', 'query_read'])
    for (const [name, args] of [['list_tables', {}], ['describe_table', { table: 'staff' }], ['query_read', { sql: 'SELECT 1' }]] as const) {
      const r: any = await c.callTool({ name, arguments: args }); expect(r.isError).toBeFalsy()
    }
    expect(((await c.callTool({ name: 'execute_write', arguments: { sql: 'DELETE FROM t' } })) as any).isError).toBe(true) // writes off by default
    await c.close()
  })
  it('refuses to connect without or with a wrong bearer token', async () => {
    await expect(client(null)).rejects.toThrow(); await expect(client('z'.repeat(32))).rejects.toThrow()
  })
  it('only /mcp exists; GET is not a stream in stateless mode', async () => {
    const h = { authorization: `Bearer ${TOKEN}` }
    expect((await handle(new Request('https://w/', { headers: h }), env, sql)).status).toBe(404)
    expect((await handle(new Request('https://w/mcp', { headers: { ...h, accept: 'text/event-stream' } }), env, sql)).status).toBe(405)
    expect((await handle(new Request('https://w/mcp', { method: 'DELETE', headers: h }), env, sql)).status).toBe(405)
  })
})

describe('URL-token fallback (off by default)', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const post = (path: string, e: object) => handle(new Request(`https://w${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body }), { ...env, ...e }, sql)
  it('is disabled unless ALLOW_PATH_TOKEN=true', async () => { expect((await post(`/mcp/${TOKEN}`, {})).status).toBe(404) })
  it('works with the right token and refuses a wrong one when enabled', async () => {
    expect((await post(`/mcp/${TOKEN}`, { ALLOW_PATH_TOKEN: 'true' })).status).toBe(200)
    expect((await post(`/mcp/${'q'.repeat(32)}`, { ALLOW_PATH_TOKEN: 'true' })).status).toBe(401)
    expect((await post('/mcp', { ALLOW_PATH_TOKEN: 'true' })).status).toBe(401) // bare /mcp still needs the header
  })
})
