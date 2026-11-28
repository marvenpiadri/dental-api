# Dontalist backend: PostgreSQL (Neon) architecture

Status: **decided 2026-11-20.** PostgreSQL on Neon replaces TiDB/MySQL. The old TiDB design was deleted (it stays in git history). Nothing in this document counts as built until its roadmap step says so and its tests pass on a real PostgreSQL.

## 1. What the code review found

Backend: Hono on Workers, about 3,050 lines, 10 route modules, 6 MySQL migrations (22 tables), R2 for files. Tests: 102 on a SQLite stand-in, 19 TiDB tests that never ran. Nothing was ever run against a real database engine of the target kind.

**Database-specific code is concentrated, which makes the move tractable:**
- `src/db/client.ts`: the TiDB HTTP driver, `?` placeholders, duplicate-key mapping, no transactions exposed.
- `src/lib/time.ts` plus every route: times are strings (`'YYYY-MM-DD HH:MM:SS.mmm'`) converted by hand.
- `db/migrations/*.sql`: MySQL DDL (`VARCHAR(64)` ids, `DATETIME(3)`, `TINYINT live`, `KEY`, `UNIQUE KEY`, `JSON`).
- Query idioms: `LIMIT ?`, `LIKE ? ESCAPE '!'`, `COALESCE(MAX(seq),0)+1`, a `CASE` in `SET` that relies on MySQL's left-to-right evaluation (`auth/routes.ts`), `parseJson` shims for drivers that return JSON as text.
- `tests/helpers/sqlite-db.ts` and `tests/tidb/*`: the test strategy itself.

**Design that exists only because TiDB lacked tools, and must go:**
| TiDB workaround | Where | PostgreSQL replacement |
|---|---|---|
| No foreign keys / CHECK: tenant isolation by convention in every query | all tables | composite foreign keys `(clinic_id, x_id)`, CHECK constraints |
| `appointment_slot` table, one row per 5-minute slot, claimed by primary key; `live` flag; orphan sweeper | `appointments/slots.ts` | one `EXCLUDE USING gist` constraint per resource (dentist, chair, patient) |
| `live` two-phase writes on invoice, document | billing, files | a normal transaction |
| `MAX(seq)+1` plus retry (6 attempts, can fail under load) | invoices, prescriptions | per-clinic counter row updated in the same transaction (gap-free, no retry) |
| `full_name_norm` collation workaround | patient | kept as `search_name` with a trigram index (immutable, collation-independent) |
| Whole-document chart replace with one version number | `PUT /patients/:id/chart` | per-tooth and per-section targeted updates with a revision log (section 4) |
| No interactive transactions | everywhere | real transactions |

**Reusable, keep as is or with small edits:** the Hono app, middleware (CORS allow-list, CSRF header, security headers, body limits, `authenticate`/`requires`), session design (opaque token, only its SHA-256 stored, idle and absolute expiry), Web Crypto password hashing with pepper, `permissions.ts` and its contract test against the frontend, keyset pagination helpers, BigInt money, request validation, error envelope, `FileStore` port and R2 adapter, prescription state machine and item cleaning, config loader.

**Replace:** the db client, migrations, time handling, slot claiming, numbering, `live` flags and the sweeper, the SQLite helper, the TiDB tests.

## 2. Stack

- PostgreSQL on Neon (current major version offered by Neon; local tests use PostgreSQL 18).
- Hono + TypeScript on Cloudflare Workers; R2 for files; Angular frontend on Pages.
- Driver: `pg` (node-postgres). Workers need the `nodejs_compat` flag for it; this is a demonstrated need, so the flag is allowed (it was forbidden "unless a dependency demonstrably needs it").
- No ORM and no query builder. SQL stays in the module that uses it, with `$1, $2` parameters. A small `Db` interface (`query`, `tx`) is the only abstraction.

## 3. Neon on Workers (connection strategy)

Sources: Neon's Cloudflare Workers guide and Cloudflare Hyperdrive guide (read 2026-11-20).
- **Production: Hyperdrive + `pg`.** Neon and Cloudflare both recommend it. Hyperdrive pools connections near the database, so a Worker never opens a TCP connection per request itself. Use the **direct** (non-pooled) Neon connection string in Hyperdrive, because Hyperdrive does the pooling. Binding `HYPERDRIVE`; code reads `env.HYPERDRIVE.connectionString`.
- Per request: create one `Client`, `connect()`, run the request, `ctx.waitUntil(client.end())`. Do not share a client across requests.
- Transactions: `BEGIN ... COMMIT` on that one client. Hyperdrive holds a connection for the length of a transaction, so transactions stay short and make no outside calls. No session-level state (`SET` without `LOCAL`, session advisory locks, `LISTEN`) because the pool is transaction-mode.
- Local `wrangler dev`: Hyperdrive `localConnectionString` pointing at a Neon dev branch or a local PostgreSQL.
- Fallback (no Hyperdrive): `@neondatabase/serverless` has the same `Client`/`Pool` API as `pg`, uses the **pooled** (`-pooler`) host and works without `nodejs_compat`. Swapping is a change in one factory function.
- Roles: a migration role (owner, DDL) and a runtime role (DML only, no DDL, not superuser). The runtime role cannot disable constraints or modify the migration table.
- Neon features we use: **branching** (a branch per test run, per preview), **point-in-time restore**, scale-to-zero for dev (it adds a cold start to the first query, so production should not scale to zero). Region: Europe, near the users and R2 (WEUR). **Legal check before real patient data (Law 09-08/CNDP):** Neon region and hosting location need a decision by the clinic owner; the earlier us-east-1 choice is not acceptable by default.

## 4. Data model: relational vs JSONB

**Native types:** `uuid` ids (generated in the API, UUIDv7-style ordering not required), `timestamptz` for instants, `date` for dates, `numeric(12,2)` for money (never float), `text` with CHECK for small enums (cheaper to migrate than `CREATE TYPE`).

**Multi-tenancy:** every clinic-owned table has `clinic_id`, and every reference to another clinic-owned row is a **composite foreign key** `(clinic_id, patient_id) REFERENCES patient (clinic_id, id)`. A row of clinic A can then never point at a row of clinic B, even through a bug. Every query still filters by `clinic_id`. No row-level security in V1 (pooling makes per-request settings fragile); revisit later.

**Relational (integrity, relationships, reporting):** clinic, staff, permissions, sessions, patients, dentists, chairs, appointments, appointment status history, treatment items, invoices and lines, payments, refunds, credit notes, documents (metadata), prescriptions metadata and numbering, expenses, stock, equipment, lab orders, audit log.

**JSONB (document-like, evolving):** tooth records, chart sections, periodontal measurements, exam snapshots, medical-history lists, prescription items and snapshot, prescription template items, clinic profile and opening hours/closures, audit `detail`. JSONB columns have a CHECK that they are the right JSON type (`jsonb_typeof(...) = 'object'`), and the API validates the structure before it is stored.

**Hard rules enforced in the database, not only in code:**
- Appointments: `EXCLUDE USING gist (clinic_id WITH =, dentist_id WITH =, tstzrange(start_at, end_at) WITH &&) WHERE (status NOT IN ('cancelled','no-show'))`, and the same for chair and patient. Needs `btree_gist` (available on Neon). A double booking is impossible, not "unlikely".
- Money: `CHECK (amount > 0)` on payments and refunds; invoice and credit-note lines cannot change after issue (a trigger rejects UPDATE/DELETE); cancel = credit note; a refund is a row that references a credit note and cannot exceed what was paid on the cancelled invoice (checked in the same transaction under a row lock).
- Numbering: `doc_counter (clinic_id, kind, year, last_seq)`; `INSERT ... ON CONFLICT DO UPDATE SET last_seq = last_seq + 1 RETURNING` inside the issuing transaction.
- Append-only tables (audit, exams, prescription events, chart revisions): a trigger rejects UPDATE and DELETE.

### Odontogram and periodontogram safety

The old API replaced the whole chart on every save. That allows one stale tab to erase a patient's chart. The new model:

```
chart_head      (clinic_id, patient_id, kind 'odontogram'|'perio', created_at)          one per patient and kind
chart_tooth     (clinic_id, patient_id, kind, tooth, data jsonb, rev int, updated_at, updated_by)   PK (patient_id, kind, tooth)
chart_section   (clinic_id, patient_id, kind, section 'globals'|'plan'|'case', data jsonb, rev int, ...)
chart_revision  (id, clinic_id, patient_id, kind, scope 'tooth'|'section'|'restore', ref, rev, before jsonb, after jsonb, at, by, reason)   append-only
```
- **Targeted updates:** `PATCH /patients/:id/chart/:kind/teeth/:tooth` with `{ expectedRev, data }`. SQL: `UPDATE chart_tooth SET data=$1, rev=rev+1 WHERE patient_id=$2 AND kind=$3 AND tooth=$4 AND rev=$5`; zero rows means 409 stale. The same transaction inserts the `chart_revision` row (before and after). Two dentists editing different teeth never conflict; the same tooth conflicts visibly.
- **Validation:** FDI tooth number, size limit, structure per kind; for perio the six sites and numeric ranges. An empty or `{}` tooth body is refused unless the request is an explicit "clear this tooth" (`{ clear: true, reason }`), which is logged.
- **No whole-chart overwrite from the client.** The only whole-chart operation is a server-side **restore** from a revision or an exam snapshot, which writes new revisions and needs `clinical.void`-level permission and a reason.
- **Exams** stay immutable full snapshots (assembled from the tooth rows at that moment).
- **Recovery:** every change is reversible from `chart_revision`; disasters from Neon point-in-time restore. A daily logical dump to R2 (see testing section) is the second line.
- Frontend impact: the chart engine keeps its in-memory chart; the save path computes which teeth or sections changed and sends only those, with the revision numbers it loaded.

## 5. Migration plan

1. **No data to migrate:** no real data exists in TiDB (it was only a test database). So the migration is a **clean redesign**, not a data copy.
2. New history: `db/migrations/0001_*.sql`... forward-only SQL files, each applied in its own transaction, recorded in `schema_migration (version, checksum, applied_at)`. The runner refuses a changed checksum. The six MySQL files are deleted from the repository once their tables are redesigned (git history keeps them).
3. Order follows the roadmap: each step brings its tables, its routes and its tests together.
4. API contract preserved where it is sound (`/v1/...` paths, error envelope, pagination shape, permission names). Changes: ids become UUID strings (unchanged to clients), times become ISO strings with `Z`, chart endpoints change (section 4).
5. Destructive steps (dropping the old files and TiDB package) happen only after the replacement for that area has passing tests.

## 6. Testing strategy

| Tier | What | Runs where | Claim it supports |
|---|---|---|---|
| Unit | pure functions: money, validation, permissions, chart validators, cursor codec, passwords | anywhere, no database | logic only |
| **PostgreSQL integration** | migrations, constraints and FKs, exclusion constraints, JSONB updates, transactions and rollback, concurrency (parallel connections), isolation, clinic isolation, append-only triggers, chart revisions | real PostgreSQL 18 (`embedded-postgres`, started per test run by a non-root user) and, on demand, a Neon branch | database behaviour |
| API | Hono app on the real PostgreSQL: login, permissions, tenant isolation, regression of every route | same | end-to-end of the backend |
| Backup and restore | dump, restore into a fresh database, compare row counts and checksums | needs `pg_dump`/`pg_restore` (not in the embedded package); run in CI or locally, plus a COPY-based round trip in the sandbox | recoverability |
| Neon smoke | migrations and a short suite against a Neon branch, run by the owner (the sandbox cannot reach Neon) | owner's machine / CI | Neon specifics (pooling, Hyperdrive, TLS) |

SQLite is **removed**: no SQLite helper, no SQLite-based test counts as PostgreSQL evidence. Tests are labelled by tier in their file names (`*.unit.test.ts`, `*.pg.test.ts`).

## 7. Revised roadmap (backend, each step ends with passing tests on real PostgreSQL)

| Step | Scope | Status |
|---|---|---|
| P0 | This document; CLAUDE.md and roadmaps switched to PostgreSQL; TiDB tasks cancelled | done |
| P1 | `pg` client + `Db`/`tx` interface; migration runner; PostgreSQL test harness; baseline schema (clinic, staff, permissions, sessions, audit); auth and team routes ported; TiDB client, SQLite helper and tests removed (unported TiDB modules parked in `legacy-tidb/`, unmounted) | **done 2026-11-20**: 41 tests pass (5 files; 36 on real PostgreSQL 18.7, 5 unit). Not yet run against Neon/Hyperdrive |
| P2 | Patients (file numbers, search with trigram index), dentists, chairs, appointments with exclusion constraints, status and reschedule history | **done 2026-11-20**: 65 tests pass (24 new on real PostgreSQL incl. 20-way booking race). Waiting list and duplicate detection are not in P2 |
| P3 | Billing: invoices, payments, credit notes, refunds, counters, immutability triggers | **done 2026-11-20**: 12 tests on real PostgreSQL (race on numbering, double-cancel, refund cap) |
| P4 | Clinical: medical history, chart tables with revision log and targeted patch API, exams, treatment plan | done (16 PostgreSQL tests) |
| P5 | Documents on R2, prescriptions and templates | done (13 PostgreSQL tests; R2 itself only via an in-memory fake, needs a real-bucket check) |
| P6 | Remaining modules: clinic settings/profile/closures/price list, letters, insurance, waiting list, messages, practice (expenses, stock ledger, lab, tasks, implants, sterilization, equipment), visit notes, quotes, medication/allergy lists, reports (summary, receivables, overdue), duplicate detection and patient merge | **done 2026-11-21** (34 more PostgreSQL tests). Merge refuses a file that holds immutable clinical or billing records (it names them) instead of rewriting history. |
| P7 | Backup/restore verification, Neon branch run, Hyperdrive deploy, load test of the hot paths | Partly done: backup/restore verified and hot paths measured locally (below). Neon branch run, real backup drill and Hyperdrive deploy are NOT done; they need the owner and explicit approval. |

The frontend plan (S1-S8 in the frontend repo's `docs/product-audit.md` §3c) continues in parallel and depends on P2 onward.

## 8. Open decisions for the owner
1. Neon region (Europe recommended) and the data-protection position for patient data hosted outside Morocco (Law 09-08/CNDP).
2. ~~Hyperdrive~~ not used (owner decision 2026-11-23).
3. Backup retention: Neon's restore window depends on the plan; choose a plan whose window matches the clinic's recovery needs, and decide where daily dumps are stored.


## P7 evidence (local PostgreSQL 16.15, not Neon)

Backup/restore: `npm run verify-backup -- <source-url> <admin-url>` dumps (custom format), restores into a scratch database and compares per-table fingerprints; `tests/backup.pg.test.ts` runs it (skipped when `pg_dump` is older than the server). Proven on PG 16 only. A real drill on Neon is still to do.

Load test: one clinic, 20,000 patients, 120,000 appointments, `ANALYZE`d, `EXPLAIN (ANALYZE, BUFFERS)` of the exact route SQL. Single connection, warm cache, so these show index use and bounded work, not concurrency.

| Query | Plan | Execution |
|---|---|---|
| Patient list, first page / deep keyset page | `ix_patient_order` index scan | 0.1 ms |
| Patient search, common term | `ix_patient_order` + filter | 0.04 ms |
| Patient search, rare term / no match | `ix_patient_order` + filter, scans the clinic's rows | 11-13 ms |
| Calendar day (80 rows), week (101 rows, capped) | `ix_appt_clinic_start` | 0.1 ms |
| Patient appointment history, page of 26 | `ix_appt_patient_start` bitmap + sort | 1.5 ms |

Known limit: search with `LIKE '%x%'` across name, phone and number cannot use the trigram indexes because of the OR plus the keyset ORDER BY, so a rare or empty search costs time linear in the clinic's patient count (about 11 ms at 20k). Fine for one clinic; if a clinic reaches several hundred thousand patients, split search into per-column trigram queries. Not measured: concurrent load, Neon latency, Hyperdrive.

## Status 2026-11-23

- **Database:** Neon project `red-meadow-47831446`, default branch, database **`dontalist`** (owner `neondb_owner`). TiDB is removed from the project. Migrations 0001-0010 are applied (recorded in `schema_migration` with checksums). The applied schema was checked against a database built from the repository's migration files: columns, constraints, indexes, triggers and functions fingerprints are identical.
- **Tests (sandbox, real PostgreSQL):** 197 passed, 1 skipped on the embedded PostgreSQL 18; the PostgreSQL 16 run passed 190/190 before the edge tests were added. The sandbox cannot open a connection to Neon, so no suite has run against Neon itself.
- **Added since P7:** central file storage on R2 (`docs/r2-storage.md`, migration 0010 replaces the `document` table with `file`), password hashing in a separate Neon Function (`docs/password-service.md`), edge tests (`tests/edges.pg.test.ts`).
- **Connection (owner decision 2026-11-23):** no Hyperdrive. The Worker connects with plain `pg` to Neon's pooled host through the `DATABASE_URL` secret (sections 3 and P7 above that mention Hyperdrive are superseded). Migrations still need the direct owner string. Not measured: Worker-to-Neon latency (the sandbox cannot reach Neon).
- **Neon Data API:** enabled by the owner on `dontalist`. It runs requests as `anonymous` / `authenticated`, and Neon had granted `authenticated` read/write on all 53 tables with no row-level security, which would let any valid Neon Auth token bypass the API's clinic isolation. Migrations 0011-0012 revoke every privilege from both roles (and from future objects); with that the Data API can read nothing. Do not grant these roles anything without row-level security.
- **Data location (owner decision 2026-11-23):** Neon in eu-central-1 and R2 in WEUR are accepted; the Law 09-08/CNDP point is not treated as a blocker.
- **Patient map link:** `patient.map_url`, only `https://maps.google.com/?ll=<lat>,<lng>` (checked in the API and by a CHECK constraint; migration 0011).
- **Still open:** Worker deploy and secrets (`DATABASE_URL`, `R2_*`, `PASSWORD_SERVICE_*`), a real backup drill on Neon, the frontend wiring (stages S2-S8).

## Status 2026-11-28: operator console and public directory

- **Migration 0016** (`clinic_subscription`, unique public address index). Written and proven on a local PostgreSQL only. **Not applied to Neon** (needs the owner's approval).
- **Operator API** `/v1/admin/*`: guarded by the `ADMIN_TOKEN` Worker secret (header `x-dontalist-admin`, 32+ characters; without it the API answers 404). Creates a clinic with its owner, public profile and first subscription period in one transaction; edits the profile (version-checked); adds and removes subscription periods (no overlaps). Clinics cannot reach it and cannot change their subscription.
- **Public API** `GET /v1/public/clinics`: no sign-in; lists a clinic only while a subscription period covers today AND its profile is `published`. Paginated (default 15, max 50), filtered by city and search in SQL, public fields only.
- **Clinics edit their own public profile** with the existing `PUT /v1/clinic/profile` (owner role). A taken public address answers 409.
- Tests: 219 pass on real PostgreSQL (the new file `tests/admin-public.pg.test.ts` has 12). The console UI was also driven in a browser against this API.
- Not built: images in public profiles (the 64 KB body limit blocks data URLs; they belong on R2), a single-clinic public endpoint for the app's public clinic page, rate limiting on the operator token (use a long random token).
