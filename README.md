# Dontalist API

Backend API for Dontalist, separate from the Angular frontend repository.

## Stack

- Hono + TypeScript
- Cloudflare Workers (Wrangler)
- TiDB Cloud using `@tidbcloud/serverless` (HTTP-based driver)
- Cloudflare R2 for private patient files and documents

## Local development

Requirements: Node.js LTS and npm.

```bash
npm install
cp .dev.vars.example .dev.vars
# Add your TiDB Cloud connection URL to .dev.vars
npm run dev
```

The local Worker runs at http://localhost:8787. The initial `/health` route does not require database credentials.

## Commands

- `npm run dev` — local Worker
- `npm run typecheck` — TypeScript check
- `npm run deploy` — deploy with Wrangler (only after Cloudflare setup)
- `npm run cf-typegen` — generate Cloudflare binding types

## Secrets and configuration

Never commit `.dev.vars`, database URLs, passwords, API keys, tokens, or production secrets. Configure production secrets with Wrangler or the Cloudflare dashboard.

## Important

Read [CLAUDE.md](./CLAUDE.md) before making changes. The API must use server-side pagination and must not load entire clinic datasets into memory. Do not implement production database features until the existing frontend contracts and current database design have been inspected.
