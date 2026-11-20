# Dontalist API

Backend API for Dontalist, separate from the Angular frontend repository.

## Stack

- Hono + TypeScript
- Cloudflare Workers (Wrangler)
- Neon PostgreSQL through Cloudflare Hyperdrive, `pg` driver (see `docs/postgres-architecture.md`)
- Cloudflare R2 for private patient files and documents

## Local development

Requirements: Node.js LTS and npm.

```bash
npm install
cp .dev.vars.example .dev.vars
# .dev.vars: DATABASE_URL (a local PostgreSQL or a Neon dev branch), PASSWORD_PEPPER, DATABASE_URL_MIGRATE (owner role)
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

## Operator access

Passwords are stored only as salted, peppered hashes. To get into any clinic account: `npm run set-password -- user@clinic.ma` prints a new temporary password and revokes that account's sessions. `npm run migrate` applies `db/migrations` (needs `DATABASE_URL_MIGRATE`; never against production without approval).

## Tests

`npm test` runs everything. `*.unit.test.ts` need no database; `*.pg.test.ts` run on a REAL PostgreSQL: a throwaway embedded PostgreSQL is started automatically (as user `pgtest` when run as root), or set `TEST_DATABASE_URL` to a local PostgreSQL / Neon scratch branch (role with CREATEDB; each test file creates and drops its own database). `npm run test:unit` runs the unit tests only.
