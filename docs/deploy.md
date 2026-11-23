# Deploying the API (Cloudflare Worker + Neon)

Runs on your computer (needs a Cloudflare login); the build sandbox has none.

1. `npx wrangler login`
2. Secrets, in one go from the JSON file you were given (never commit it; delete it afterwards):
   `npx wrangler secret bulk worker-secrets.json`
   Keys: `DATABASE_URL` (Neon **pooled** host, runtime role `dontalist_rt`), `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `PASSWORD_SERVICE_URL`, `PASSWORD_SERVICE_SECRET`.
3. `npm run deploy` (`workers_dev: true`, so it answers on `dontalist-api.<your-subdomain>.workers.dev` before the custom domain exists; the custom domains `app.` and `api.dontalist.com` are in `wrangler.jsonc` vars).
4. First owner account: `npm run create-clinic` (uses the OWNER string, direct host, in `.dev.vars` as `MIGRATE_DATABASE_URL`-style; see `tools/create-clinic.ts`).
5. Check: `curl https://<worker-host>/health`, then sign in from the app with its `/config.json` `apiUrl` set to that host.

Roles: `neondb_owner` migrates and creates clinics (never in the Worker). `dontalist_rt` is the Worker's role (migrations 0013/0014). Role `dontalist_app` was created first by Neon with admin rights and is unused; delete it in the Neon console (Roles).
Rotate: the runtime password was generated in the build sandbox and shown in chat. Reset it (`ALTER ROLE dontalist_rt PASSWORD '...'` as owner) and run `wrangler secret put DATABASE_URL` again.
