import { describe, expect, it } from 'vitest'
import { handle, type Env, type Sql } from '../src/index'
import { readOnly, writable } from '../src/guard'

const TOKEN = 'x'.repeat(32)
const calls: string[] = []
const sql: Sql = { rows: async (q) => { calls.push(q); return [{ a: 1 }] }, run: async (q) => { calls.push(q); return 1 } }
const rpc = (env: Partial<Env>, body: unknown, token: string | null = TOKEN) =>
  handle(new Request('https://x/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }),
    { TIDB_DATABASE_URL: 'u', MCP_TOKEN: TOKEN, ...env }, sql)
const call = async (env: Partial<Env>, name: string, args: unknown) =>
  ((await (await rpc(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json()) as any).result

describe('db mcp', () => {
  it('fails closed without a token configured, and rejects a bad or missing token', async () => {
    expect((await rpc({ MCP_TOKEN: '' }, {})).status).toBe(503)
    expect((await rpc({}, {}, 'wrong'.padEnd(32, 'x'))).status).toBe(401)
    expect((await rpc({}, {}, null)).status).toBe(401)
  })
  it('lists the four tools', async () => {
    const j = (await (await rpc({}, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as any
    expect(j.result.tools.map((t: any) => t.name).sort()).toEqual(['describe_table', 'execute_write', 'list_tables', 'query_read'])
  })
  it('read tool runs a SELECT but refuses writes and multi-statements', async () => {
    expect((await call({}, 'query_read', { sql: 'SELECT 1' })).isError).toBeUndefined()
    for (const q of ['DELETE FROM t', 'SELECT 1; DROP TABLE t', 'SELECT * FROM t FOR UPDATE', 'SELECT 1 INTO OUTFILE "/x"']) expect((await call({}, 'query_read', { sql: q })).isError).toBe(true)
  })
  it('write tool is off by default and blocks dangerous statements when on', async () => {
    expect((await call({}, 'execute_write', { sql: 'INSERT INTO t VALUES (1)' })).isError).toBe(true)
    const on = { ALLOW_WRITES: 'true' }
    expect((await call(on, 'execute_write', { sql: 'INSERT INTO t VALUES (?)', params: [1] })).isError).toBeUndefined()
    for (const q of ['DROP DATABASE x', 'GRANT ALL ON *.* TO u', 'CREATE USER u', 'DELETE FROM sys.x', 'SELECT 1']) expect((await call(on, 'execute_write', { sql: q })).isError).toBe(true)
  })
  it('guards in isolation', () => {
    expect(readOnly('  select 1;')).toBe('select 1'); expect(() => readOnly('update t set a=1')).toThrow(); expect(writable('create table t (a int)')).toBeTruthy()
  })
})
