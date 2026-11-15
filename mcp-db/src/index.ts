import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { connect } from '@tidbcloud/serverless'
import { z } from 'zod'
import { readOnly, safeEqual, writable } from './guard'

export type Env = { TIDB_DATABASE_URL: string; MCP_TOKEN: string; ALLOW_WRITES?: string; ALLOW_PATH_TOKEN?: string }
export type Sql = { rows(sql: string, params: unknown[]): Promise<unknown[]>; run(sql: string, params: unknown[]): Promise<number> }
const MAX_ROWS = 200

export function realSql(env: Env): Sql {
  const c = connect({ url: env.TIDB_DATABASE_URL, fullResult: true, fetch: (i, o) => fetch(i, { ...o, signal: AbortSignal.timeout(10_000) }) })
  return {
    rows: async (q, p) => (((await c.execute(q, p as never)) as { rows?: unknown[] }).rows ?? []),
    run: async (q, p) => Number(((await c.execute(q, p as never)) as { rowsAffected?: number }).rowsAffected ?? 0),
  }
}
const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] })
const err = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: String(e instanceof Error ? e.message : e).slice(0, 400).replace(/mysql:\/\/\S+/g, '[url]') }] })

export function buildServer(env: Env, sql: Sql): McpServer {
  const s = new McpServer({ name: 'dontalist-db', version: '0.1.0' }, { instructions: 'Test database for Dontalist. Use list_tables / describe_table first. Keep queries small: results are capped at 200 rows.' })
  s.registerTool('list_tables', { description: 'List tables in the connected database.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => { try { return text(await sql.rows('SELECT table_name AS name, table_rows AS approx_rows FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name', [])) } catch (e) { return err(e) } })
  s.registerTool('describe_table', { description: 'Columns and indexes of one table.', inputSchema: { table: z.string().regex(/^[A-Za-z0-9_]{1,64}$/) }, annotations: { readOnlyHint: true } },
    async ({ table }) => { try { return text({ columns: await sql.rows('SELECT column_name, column_type, is_nullable, column_key FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position', [table]),
      indexes: await sql.rows('SELECT index_name, non_unique, seq_in_index, column_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? ORDER BY index_name, seq_in_index', [table]) }) } catch (e) { return err(e) } })
  s.registerTool('query_read', { description: 'Run ONE read-only statement (SELECT/SHOW/DESCRIBE/EXPLAIN). Use ? placeholders with params. Returns at most 200 rows: add your own LIMIT.',
    inputSchema: { sql: z.string().max(20000), params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(100).default([]) }, annotations: { readOnlyHint: true } },
    async ({ sql: q, params }) => { try { const rows = await sql.rows(readOnly(q), params); return text({ rowCount: rows.length, truncated: rows.length > MAX_ROWS, rows: rows.slice(0, MAX_ROWS) }) } catch (e) { return err(e) } })
  s.registerTool('execute_write', { description: 'Run ONE write/DDL statement on the TEST database (INSERT/UPDATE/DELETE/CREATE/ALTER/TRUNCATE/DROP TABLE). Disabled unless the server has ALLOW_WRITES=true.',
    inputSchema: { sql: z.string().max(20000), params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(100).default([]) }, annotations: { readOnlyHint: false, destructiveHint: true } },
    async ({ sql: q, params }) => { try { if (env.ALLOW_WRITES !== 'true') throw new Error('writes are disabled on this server'); return text({ rowsAffected: await sql.run(writable(q), params) }) } catch (e) { return err(e) } })
  return s
}

export async function handle(req: Request, env: Env, sql: Sql = realSql(env)): Promise<Response> {
  const url = new URL(req.url)
  const isPathToken = env.ALLOW_PATH_TOKEN === 'true' && url.pathname.startsWith('/mcp/')
  if (url.pathname !== '/mcp' && !isPathToken) return new Response('Not found', { status: 404 })
  // Fail closed: no configured token, no service.
  if (!env.MCP_TOKEN || env.MCP_TOKEN.length < 24) return new Response('Service not configured', { status: 503 })
  // Normal: "Authorization: Bearer <token>" (Claude.ai "Request headers"). Fallback, off by default: the token as the last URL segment,
  // for accounts that do not have Request headers yet. It can end up in logs and URLs, so it is a weaker mode: use only with a read-only test DB user.
  const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')
  const presented = isPathToken ? decodeURIComponent(url.pathname.slice('/mcp/'.length)) : m?.[1]
  if (!presented || !safeEqual(presented, env.MCP_TOKEN)) return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } })
  // Stateless: no server-initiated stream and no sessions to delete, so only POST is served (the spec allows 405 for GET).
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
  const server = buildServer(env, sql)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  return transport.handleRequest(req)
}
export default { fetch: (req: Request, env: Env) => handle(req, env) }
