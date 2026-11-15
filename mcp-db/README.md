# dontalist-db-mcp

A remote MCP server (Cloudflare Worker) so Claude.ai can inspect and run **read-only** tests against the Dontalist **test** TiDB database. It runs on Cloudflare, so it can reach TiDB where Claude's sandbox cannot.

Tools: `list_tables`, `describe_table`, `query_read` (one SELECT/SHOW/DESCRIBE/EXPLAIN, max 200 rows) and `execute_write` (**disabled** until you set `ALLOW_WRITES` to `"true"`).

Scope: test only. Not for production. Do not merge to `main`.

## Status: what is and is not verified
| Item | Status |
|---|---|
| Streamable HTTP at `/mcp` (initialize, tools/list, tools/call) driven by the official MCP client | Verified, 10 tests |
| Bearer check, 401/503 fail-closed, POST only (GET/DELETE answer 405), other paths 404 | Verified |
| Bundle builds for Workers (`wrangler deploy --dry-run`) | Verified |
| Running against real TiDB | **Not verified** (needs your deploy) |
| Claude.ai accepting it as a custom connector | **Not verified** (needs your account) |

## 1. TiDB: database and a read-only user
Run as an admin in the TiDB Cloud SQL editor (never put the admin password in the Worker):

```sql
CREATE DATABASE IF NOT EXISTS dontalist_test;
-- TiDB Cloud usernames carry your cluster prefix: the part of your admin username before ".root".
CREATE USER '<PREFIX>.mcp_ro'@'%' IDENTIFIED BY '<long random password>';
GRANT SELECT ON dontalist_test.* TO '<PREFIX>.mcp_ro'@'%';
```
If your plan does not allow `CREATE USER` in SQL, create an SQL user in the TiDB Cloud console and grant it **only** SELECT on `dontalist_test`.

The Worker's URL must end in `/dontalist_test` and use this user. `list_tables` and `describe_table` only show what the user can see. Create the tables with the migrations using your admin credentials from your own machine (`npm run migrate` in the repo root, pointed at `dontalist_test`); the MCP user never needs more than SELECT while `execute_write` is off. To allow writes later, grant INSERT/UPDATE/DELETE (and DDL only if you want it) to a *separate* user and redeploy with `ALLOW_WRITES`.

## 2. Deploy to Cloudflare
```bash
cd mcp-db && npm install
npx wrangler login                                   # once
npx wrangler secret put TIDB_DATABASE_URL            # mysql://<PREFIX>.mcp_ro:<password>@gateway01.us-east-1.prod.aws.tidbcloud.com/dontalist_test
npx wrangler secret put MCP_TOKEN                    # a random string of 24+ characters, e.g. from: openssl rand -hex 32
npx wrangler deploy
```
- Required Cloudflare configuration is already in `wrangler.jsonc`: Worker name `dontalist-db-mcp`, `vars.ALLOW_WRITES = "false"`, no Durable Objects, no `nodejs_compat`, no bindings. Secrets are set with the commands above, never in files.
- `wrangler deploy` prints the URL: `https://dontalist-db-mcp.<your-account-subdomain>.workers.dev`. The MCP endpoint is that URL plus **`/mcp`**. The subdomain is specific to your Cloudflare account, so it can only be read from the deploy output (or Workers & Pages → dontalist-db-mcp → Settings → Domains & Routes).
- Quick check: `curl -i https://dontalist-db-mcp.<sub>.workers.dev/mcp` must answer `401`.

## 3. Add it in Claude.ai
Go to **Customize → Connectors → Add custom connector** (the Free plan allows one custom connector).
1. **Name:** `Dontalist test DB`
2. **MCP server URL:** `https://dontalist-db-mcp.<your-account-subdomain>.workers.dev/mcp`
3. **Authentication:** **No sign-in** (Claude's docs: for an API key or bearer token, choose No sign-in and add it under Request headers).
4. **Request headers → add header:**
   - Name: `authorization` (pick it from the list)
   - Value: `Bearer ` followed by your `MCP_TOKEN`, including the space, e.g. `Bearer 3f9a...`. Claude sends the value exactly as typed, so a value without `Bearer ` is rejected by this server.
   - Mark it **Required**.
5. Click **Add**. Auth settings cannot be edited later: to change them, remove the connector and add it again.
6. In a chat, press **+ → Connectors** and switch the connector on for that conversation. Under Customize → Connectors you can set `execute_write` to **Blocked** as a second lock.

Per Claude's docs, **Request headers is a beta available to a limited set of organizations**. If you do not see that section in the dialog, you do not have it yet. Fallback (weaker): set `"ALLOW_PATH_TOKEN": "true"` in `wrangler.jsonc`, redeploy, and use `https://dontalist-db-mcp.<sub>.workers.dev/mcp/<MCP_TOKEN>` as the URL with **No sign-in** and no header. The token is then part of the URL and can appear in logs, so keep the DB user read-only, and turn the fallback off after the test phase.

## 4. First checks in Claude.ai
Ask: "Use the Dontalist test DB connector: call `list_tables`, then `describe_table` for `appointment_slot`, then `query_read` with `SELECT VERSION() AS v, DATABASE() AS db`." Expect `db = dontalist_test`. That is the real connection confirmation.

## Limits
- One shared token, no per-user identity. Rotate with `wrangler secret put MCP_TOKEN` and re-add the connector.
- SQL guards (single statement, read-only keywords, blocked system schemas) are defence in depth; the real protection is the user's SELECT-only grant on `dontalist_test`.
- Results are capped at 200 rows; add your own LIMIT.
- Delete the Worker, the token and the MCP user when the test phase ends.
