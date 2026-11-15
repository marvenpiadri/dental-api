# dontalist-db-mcp

Remote MCP server (Cloudflare Worker) that lets Claude inspect and, if enabled, change a **test** TiDB database. It runs on Cloudflare, so it can reach TiDB even where Claude's sandbox cannot.

Tools: `list_tables`, `describe_table`, `query_read` (one SELECT/SHOW/DESCRIBE/EXPLAIN, max 200 rows), `execute_write` (one INSERT/UPDATE/DELETE/DDL statement; **off** unless `ALLOW_WRITES=true`).

## Deploy (test database only)
1. In TiDB Cloud create database `dontalist_test` and a user limited to it. Do not use root or `sys`.
2. `cd mcp-db && npm install`
3. `npx wrangler secret put TIDB_DATABASE_URL` (serverless-driver URL ending `/dontalist_test`)
4. `npx wrangler secret put MCP_TOKEN` (any random string of 24+ characters; the server refuses to run without it)
5. To allow writes, set `"ALLOW_WRITES": "true"` in `wrangler.jsonc` vars. `npx wrangler deploy`
6. Claude Code: `claude mcp add --transport http dontalist-db https://dontalist-db-mcp.<account>.workers.dev/mcp --header "Authorization: Bearer <MCP_TOKEN>"`

## Limits
- Auth is one bearer token. Whether claude.ai's custom-connector screen can send a bearer header is unconfirmed (docs not reachable from the build sandbox); Claude Code can. For claude.ai, OAuth would be needed.
- SQL guards are defence in depth; the real protection is the DB user's grants.
- Tested: 5 unit tests plus a local workerd smoke test (auth, tool list). NOT tested against TiDB.
- Delete the Worker (or the token) when the test phase ends.
