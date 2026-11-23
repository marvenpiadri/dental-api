# Dontalist API — Instructions for Claude

## Project purpose

This repository is the separate backend for Dontalist. The Angular frontend lives in the separate repository:

- Frontend: https://github.com/marvenpiadri/dental
- Backend: https://github.com/marvenpiadri/dental-api

The frontend is currently being completed separately. Do not merge the Angular application into this repository.

## Required stack

- TypeScript
- Hono as the API framework
- Cloudflare Workers as the runtime, developed/deployed with Wrangler
- Neon PostgreSQL as the database (decided 2026-11-20; TiDB/MySQL is removed, see `docs/postgres-architecture.md`). The database is named `dontalist` (Neon project `red-meadow-47831446`, default branch)
- `pg` (node-postgres) with a plain connection to Neon's pooled host (`DATABASE_URL` Worker secret) as the driver; no Hyperdrive (owner decision 2026-11-23)
- Cloudflare R2 for private files/documents when that integration is implemented

This is a Cloudflare Workers application, **not a conventional Node.js server**. Workers run on a V8/Web APIs runtime with a Node.js compatibility layer, not a complete Node.js environment.

- Do not use Express, `mysql2`, an ORM, or Node-only packages other than `pg`.
- `nodejs_compat` is enabled because `pg` needs it. Add no other compatibility flags without a demonstrated need.
- Prefer Web Standard APIs and Cloudflare bindings.
- Read secrets from Worker environment bindings; never hardcode or commit secrets.

## Database

Architecture, data model, connection strategy and roadmap: `docs/postgres-architecture.md` (the old TiDB design was deleted).

- Use `pg` with `env.DATABASE_URL` (Neon's pooled `-pooler` host): one client per request, `ctx.waitUntil(client.end())`, short transactions, no session-level state (`SET` without `LOCAL`, session advisory locks, `LISTEN`). Migrations use the direct (non-pooled) owner string. Neon's Data API roles (`anonymous`, `authenticated`) must hold no privileges on clinic tables (migration 0011).
- Use PostgreSQL natively: `uuid`, `timestamptz`, `numeric` for money, CHECK constraints, composite `(clinic_id, id)` foreign keys for tenant isolation, exclusion constraints, JSONB where the data is document-like. No ORM; parameterized SQL (`$1`) only.
- Clinical charts (odontogram, periodontogram): never replace a whole chart from the client. Targeted per-tooth/section updates with `expectedRev`, an append-only revision log in the same transaction, server-side restore only.
- Migrations: forward-only SQL in `db/migrations`, applied in a transaction each, checksummed in `schema_migration`.
- Tests: label tiers. Unit tests need no database. Database behaviour is proven only by integration tests on real PostgreSQL. SQLite or mocks never count as PostgreSQL evidence.
- Never commit connection strings. Runtime role is DML-only; migrations use a separate owner role.

## Data loading and pagination — mandatory

Never load entire tables, entire clinic datasets, or a patient's complete history just because a screen is opened.

- Implement pagination on the server/API and in SQL. Angular must not fetch thousands of records and paginate/filter them locally.
- Apply tenant/clinic scoping, search filters, sorting, and pagination in database queries.
- Validate and cap page sizes on the server. Use a sensible default (25) and maximum (100), unless a particular endpoint has a justified different limit.
- Use deterministic ordering with a unique tie-breaker.
- Use cursor/keyset pagination for large or frequently changing histories where appropriate; offset pagination is acceptable for smaller admin lists when total counts/page navigation are needed.
- Do not use unbounded queries. Avoid `SELECT *`; select only the columns needed by the screen.
- Avoid fetching total counts on every request if they are expensive or unnecessary; design response metadata deliberately.
- Load patient-file sections on demand. Patient overview, medical history, odontogram, periodontogram, treatments, invoices, prescriptions, and documents should not all be fetched in one giant response.
- Use date-range filters for calendars, appointments, and reports.
- Keep database result sets and serialized responses bounded to protect Worker memory.

## Dontalist product constraints

- One clinic account represents one physical clinic location; do not design multi-branch clinic accounts.
- Enforce clinic/tenant isolation on the server for every clinic-owned resource. Never trust a clinic ID supplied by the browser without checking it against the authenticated user's membership.
- Roles include owner, administrator, dentist, assistant, receptionist, and accountant. Authorization must be enforced server-side, not only in Angular.
- Payments are recorded manually; do not add online patient checkout.
- The two dental charts are the odontogram and periodontogram. Do not invent additional chart modules.
- Prescriptions use clinic/doctor-created templates; do not add a Moroccan drug catalogue or medical-certificate module without an explicit product decision.
- Do not implement CNSS/CNOPS claims/PDF generation in V1.
- The app supports English and French. Arabic RTL is not currently planned.
- Insurance provider association is distinct from invoice payer/payment handling.

Treat these as product constraints, not permission to invent a new schema. Verify the actual frontend models, API contracts, and database design before implementing endpoints or migrations.

## First task before substantive backend implementation

1. Inspect the frontend repository, especially its current models, stores/repositories, API contracts, validation rules, and database design documents/migrations.
2. Report what already exists and identify mismatches or missing backend contracts.
3. Propose a minimal backend implementation plan that preserves existing frontend behavior.
4. Do not rewrite frontend code or invent a replacement schema.
5. Do not implement the whole backend in one pass. Work incrementally, with tests for each feature.

## Engineering rules

- Keep the implementation small and understandable. Avoid unnecessary abstractions and dependencies.
- Validate all input at the API boundary.
- Use parameterized SQL; never interpolate user input into SQL.
- Enforce authorization and tenant isolation on every relevant query and mutation.
- Use bounded request/response sizes and pagination.
- Return consistent, non-sensitive error responses. Never expose SQL, secrets, stack traces, or internal database details to clients.
- Add tests for authorization, tenant isolation, pagination boundaries, validation, and concurrent operations where relevant.
- Do not claim a feature is complete unless its tests pass.
- Do not deploy or run destructive production migrations without explicit approval.
