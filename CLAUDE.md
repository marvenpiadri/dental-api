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
- TiDB Cloud as the MySQL-compatible database
- `@tidbcloud/serverless` as the database driver
- Cloudflare R2 for private files/documents when that integration is implemented

This is a Cloudflare Workers application, **not a conventional Node.js server**. Workers run on a V8/Web APIs runtime with a Node.js compatibility layer, not a complete Node.js environment.

- Do not use Express, `mysql2`, TCP database connections, or Node-only packages.
- Do not add `nodejs_compat` or other compatibility flags unless a required dependency demonstrably needs them.
- Prefer Web Standard APIs and Cloudflare bindings.
- Read secrets from Worker environment bindings; never hardcode or commit secrets.

## Database driver

Use `@tidbcloud/serverless` to connect to TiDB Cloud. Prefer its stateless HTTP query interface for ordinary independent queries.

The driver's stateful connection and interactive transaction functionality is experimental. Do not assume it behaves like a mature persistent MySQL connection pool. Before relying on transactions for critical multi-step operations (for example, invoice/payment posting or appointment conflict handling), verify the current driver and TiDB documentation, identify the consistency guarantees, and add concurrency tests. Do not silently implement unsafe transaction workarounds.

Keep SQL compatible with TiDB's MySQL dialect. Do not introduce PostgreSQL-specific syntax, types, extensions, RLS policies, or migration tooling.

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
