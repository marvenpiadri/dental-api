# Dontalist backend — revised architecture (for review, nothing implemented)

Status: **proposal awaiting approval.** No backend code, schema or migration has been written for this document.
Source of truth for decisions: the "Revised Architecture Approval" message (2026-11-14) and `CLAUDE.md`.
Where this document says **Verified**, a source was read in this session. **Assumption** means it was not verified and needs a test or a decision.

---

## 0. Facts and limits that shape everything

### Verified (docs read in this session)

| Fact | Source |
|---|---|
| `@tidbcloud/serverless` talks to TiDB over **HTTPS** (`fetch`), so it runs in Workers with no TCP and no certificate files. Connection string: `mysql://user:password@host/database`; special characters in credentials must be percent-encoded. | [TiDB serverless driver docs](https://docs.pingcap.com/developer/serverless-driver/) |
| Stateless `execute()` is the default. **Transactions (`begin/commit/rollback`) are labelled experimental**; `begin()` accepts `READ COMMITTED` or `REPEATABLE READ` (default). Statements **must not run in parallel inside one transaction**. | same, and the [npm README](https://www.npmjs.com/package/%40tidbcloud%2Fserverless) |
| Limits: **10,000 rows per query**, **one SQL statement per call** (no multi-statement), private endpoints not supported. | same |
| Type mapping: `BIGINT`, `DECIMAL`, `DATETIME`, `TIMESTAMP`, `DATE`, `TIME` come back as **strings**; `JSON` comes back as an object; blobs as `Uint8Array`. | same |
| TiDB has **no gap locks**. Locking a non-existent key works only for point lookups under `REPEATABLE READ`. Autocommit `SELECT … FOR UPDATE` does not wait for locks. Deadlock → error 1213, lock wait timeout → 1205. | [TiDB pessimistic transactions](https://docs.pingcap.com/tidb/dev/pessimistic-transaction/) |
| Pessimistic mode is the default **for newly created self-managed clusters** since v3.0.8. The page does **not** say what TiDB Cloud uses. | same |
| Smart Placement moves a Worker near its backend only for `fetch` handlers (not RPC), and only to places that already saw traffic. Explicit hints exist: `placement.region = "aws:us-east-1"`. | [Cloudflare Smart Placement](https://developers.cloudflare.com/workers/configuration/smart-placement/), [placement hints](https://developers.cloudflare.com/changelog/2026-01-22-explicit-placement-hints/) |
| TiDB has no triggers, procedures, events or UDFs. `CHECK` exists but is **off by default** (`tidb_enable_check_constraint`). Foreign keys are enforced from v6.6 and GA in v8.5, with limits (parent index required, matching types). | docs read earlier in this project |

### Not reachable from here

The sandbox's network proxy resets connections to `gateway01.us-east-1.prod.aws.tidbcloud.com`. **I cannot run the connection check, the transaction tests, or the slot-claim tests from this environment.** Section 5 gives them as scripts to run on your machine or on a deployed Worker. Until you or I run them against the real cluster, every TiDB behaviour below that is not in the table above is an assumption.

### Assumptions that must be tested before they are relied on

- The cluster version supports foreign keys, and whether `tidb_enable_check_constraint` can be switched on in your tier.
- Whether a failed multi-row `INSERT` (duplicate key on one row) is all-or-nothing on TiDB Cloud (standard SQL says yes).
- What `begin()` actually guarantees under concurrent writers (section 5).
- Latency between a Worker and `us-east-1`, and from Morocco (section 8).
- Which other TiDB Cloud regions your tier offers. `ticloud serverless region` lists them; I could not read the list.

---

## 1. Revised architecture

```mermaid
flowchart LR
  B[Browser<br/>Angular app<br/>IndexedDB read cache] -->|HTTPS, cookie + CSRF header<br/>CORS with credentials| API[api.dontalist.com<br/>Hono Worker]
  B -->|page load| WEB[dontalist.com<br/>Angular SSR Worker]
  WEB -->|service binding<br/>forwards Cookie| API
  API -->|HTTPS, @tidbcloud/serverless| DB[(TiDB Cloud<br/>MySQL-compatible<br/>database: dontalist)]
  API -->|R2 binding<br/>streams, never buffers| R2[(Cloudflare R2<br/>private bucket)]
  B -. optional later:<br/>presigned PUT .-> R2
```

Rules this diagram encodes:

- Two repositories, two deployments: `dental` (Angular SSR Worker, serves pages) and `dental-api` (Hono Worker, the **only** thing that touches TiDB, R2 and secrets).
- The SSR Worker holds **no database credentials and no R2 binding**. To learn who is signed in it calls the API through a service binding (`/api/v1/auth/me`), forwarding the visitor's `Cookie` header.
- The browser calls `api.dontalist.com` directly for data. The cookie is `HttpOnly`; JavaScript never sees the session token.
- Placement: the API Worker gets `placement.region = "aws:us-east-1"` so its several database round trips are short. Whether that helps users in Morocco is measured in section 8, not assumed.

**Why a service binding rather than a public call:** it never leaves Cloudflare's network, needs no extra auth between the Workers, and the API still re-checks the cookie itself. (Smart Placement does not apply to RPC; a plain `fetch()` through the binding is fine.)

---

## 2. Authentication and cookie flow

### Cookie design (decision needed, see section 12 D1)

The browser is on `dontalist.com`; the API is on `api.dontalist.com`. They are **same-site but cross-origin**.

| Option | Cookie | SSR can read it | Notes |
|---|---|---|---|
| **A (recommended)** | `__Secure-dl_session; Domain=dontalist.com; Path=/; Secure; HttpOnly; SameSite=Lax` | yes: the browser sends it to the SSR Worker too | Honours the earlier requirement that SSR knows the user before rendering. Cookie travels to every `*.dontalist.com` host, so no untrusted subdomain may ever exist (subdomain takeover = session theft). |
| B | `__Host-dl_session` on `api.dontalist.com` only | no | Strongest isolation, but SSR cannot see the session. Protected pages render as a shell and the browser loads data after. Private data is never server-rendered anyway. |

`__Host-` forbids a `Domain` attribute, so A uses `__Secure-`. Both are `HttpOnly`, `Secure`, and carry a random opaque token. Only its SHA-256 is stored (prototype behaviour, kept).

### Flow

```mermaid
sequenceDiagram
  participant U as Browser (dontalist.com)
  participant W as SSR Worker
  participant A as API (api.dontalist.com)
  participant D as TiDB
  U->>A: OPTIONS /api/v1/auth/login (preflight)
  A-->>U: Allow-Origin: https://dontalist.com, Allow-Credentials, Allow-Headers: Content-Type, X-CSRF-Token
  U->>A: POST /auth/login {email, password} (credentials: include)
  A->>D: staff by email; verify PBKDF2 (Web Crypto) with pepper
  A->>D: INSERT auth_session(token_hash, clinic_id, staff_id, csrf, expiry)
  A-->>U: 200 {session: name, role, permissions, csrf} + Set-Cookie (HttpOnly)
  U->>A: GET/POST … (cookie sent) + X-CSRF-Token on writes
  A->>D: session by token_hash JOIN staff (status, role, overrides) on EVERY request
  U->>W: GET /today (page load, cookie sent under option A)
  W->>A: service binding GET /auth/me (Cookie forwarded)
  A-->>W: {session} or 401
  U->>A: POST /auth/logout
  A->>D: revoke session
  A-->>U: Set-Cookie expired
```

### Rules

- **Authentication is re-read from the database on every request**: session validity, staff status (suspended/deactivated), role and permission overrides. A JWT is not used; revocation is therefore immediate. (`jose` is not needed.)
- **Expiry:** idle timeout and absolute lifetime, both enforced server-side. The prototype used 2 h idle / 12 h absolute, marked "decision pending" — **to confirm (D9).** `last_seen` is written at most every 5 min to limit writes.
- **Refresh:** there is no refresh token. The idle timer slides on use. When the absolute lifetime ends the person signs in again. This keeps one revocable credential instead of two.
- **CSRF:** every non-GET request needs `X-CSRF-Token` equal to the session's token (returned by login and `/auth/me`, kept in memory only) **and** an `Origin` header on the allow-list. SameSite=Lax is a third layer, not the only one.
- **CORS:** exact origin allow-list from configuration (no `*`, no reflecting arbitrary origins), `Access-Control-Allow-Credentials: true`, explicit methods and headers, `Vary: Origin`, preflight cached.
- **Logout / password change / reset / suspension:** each revokes sessions in the database; suspension also blocks login. Reset tokens are random, single-use, 1 h, stored hashed.
- **Brute force:** 5 failures → 15 min lock per account (prototype). Per-IP limiting needs a Cloudflare rate-limiting rule or binding (not in-memory; isolates do not share memory). Unverified which Cloudflare feature fits the plan.
- **PIN:** stays a local quick-unlock after full sign-in. The server never accepts a PIN as a credential.
- **Password hashing:** PBKDF2-SHA-256, 100,000 iterations + server pepper (prototype). **Not reduced for any plan.** Measured locally at ≈ 17 ms per hash in workerd; that is a local wall-clock number, not Cloudflare's CPU meter. It is benchmarked on a deployed Worker (section 8). If OWASP's current minimum for PBKDF2 is higher than 100k, iterations go up, and Paid's CPU budget allows it. (Assumption: I did not re-check the current OWASP figure in this session.)
- **Authorization:** every route declares the permission it needs; the server derives it from the role defaults plus the owner's per-person extra/removed lists. The frontend's table is **copied** into the API (`src/auth/permissions.ts`) with a contract test that fails if the two tables differ, plus a test that every route names a permission.

---

## 3. Identity and tenant model

**One clinic = one physical location.** The frontend's `locations` list collapses to the single `clinic` row (its `locationId` fields are dropped on import and reported).

```mermaid
erDiagram
  clinic ||--o{ staff : employs
  staff ||--o| dentist_profile : "is (if dentist)"
  staff ||--o{ staff_permission : "overrides"
  staff ||--o{ auth_session : "signs in"
  clinic ||--o{ patient : owns
  clinic ||--o{ chair : has
  patient ||--o{ appointment : books
  staff ||--o{ appointment : "treats (dentist)"
  chair ||--o{ appointment : uses
  appointment ||--o{ appointment_slot : claims
  patient ||--o{ exam : charts
  patient ||--o{ invoice : billed
  invoice ||--o{ payment : settled_by
```

- **Clinic identity.** `clinic.id` is the tenant. It is **never** accepted from the browser. It comes from the verified session: `auth_session.clinic_id`, which was copied from `staff.clinic_id` at login.
- **Staff identity.** One `staff` row per human. `email_norm` is globally unique (a person who works in two clinics has two accounts; multi-clinic accounts are out of scope). A staff row may have **no password** — a profile-only person who appears on the calendar but cannot sign in.
- **Dentist.** A staff row with `role = 'dentist'` plus an optional 1:1 `dentist_profile` (specialty, colour, working hours, phone, e-mail, registration number, photo file). Role = what you may do; profile = who you are professionally; account = whether you can sign in. These stay three separate things. Migration keeps each frontend `Dentist.id` as the `staff.id`.
- **Roles and permissions.** Roles are the six in `auth-rules.ts`. Permissions are `area.action` strings; defaults live in code; `staff_permission(clinic_id, staff_id, permission, effect)` holds the owner's `extra` / `removed` overrides exactly as the frontend models them. Owner-only permissions (`OWNER_ONLY`) are re-applied on the server.
- **Ownership of every clinic record.** Every clinic-owned table has `clinic_id NOT NULL`, and every query has `clinic_id = ?` from the session. Child tables carry `clinic_id` too (denormalised on purpose, so a child can never be fetched by id alone).
- **Relationship integrity.** Preferred: **composite foreign keys** `(clinic_id, patient_id) → patient(clinic_id, id)`, so the database itself refuses a cross-clinic link. TiDB supports FKs on recent versions with conditions (matching types, parent index, no BLOB/TEXT) — **whether your cluster has them enabled is unverified (test T0).** If not, API-level ownership checks stay and a scheduled integrity query reports any cross-clinic reference.
- **Ids.** `VARCHAR(64)`. The frontend ids are UUIDs (`crypto.randomUUID()`), with a `ev-<time>-<rand>` fallback; import keeps them verbatim. The prototype's 26-char ids are **not** used. New server ids are UUIDv4 strings (same shape, no migration step). Keyset pagination orders by `(created_at, id)`.

Tenant isolation tests (section 10) attack every resource with a second clinic's valid session.

---

## 4. Appointment conflict design (slot claims)

### Problem

The frontend checks dentist, chair **and patient** overlap across the full duration (`findConflicts`), against half-open intervals, for statuses `scheduled, confirmed, arrived, in-progress, completed`. The server must repeat that atomically. TiDB gives us no trigger, no exclusion constraint and **no gap lock**, so "SELECT overlapping rows then INSERT" is a race (two receptionists both see "free"). A range check cannot be made safe by locking.

### Design: turn "no overlap" into "no duplicate primary key"

```
appointment_slot
  clinic_id        VARCHAR(64)
  resource_kind    ENUM-like VARCHAR(8)   -- 'dentist' | 'chair' | 'patient'
  resource_id      VARCHAR(64)
  slot_start       DATETIME(0)            -- UTC, aligned to the 5-minute grid
  appointment_id   VARCHAR(64)
  PRIMARY KEY (clinic_id, resource_kind, resource_id, slot_start)
```

An appointment from 10:00 to 10:45 claims the slots 10:00, 10:05 … 10:40 for its dentist, its chair and its patient (3 × 9 rows). Two appointments overlap **iff** they claim the same key, so the database's primary-key uniqueness is the lock. One multi-row `INSERT` carries all claims; if any key exists the whole statement fails with 1062 and nothing is claimed.

- **Grid:** 5 minutes (adjustable). Minimum duration is 15 min, maximum 480 min → at most 96 rows per resource, 288 per appointment. **Assumption to verify on real data:** every existing start and end falls on the grid. The importer reports misaligned appointments instead of changing them (D6).
- **Half-open intervals:** the last claimed slot is `end - 5 min`, so 10:00–10:45 and 10:45–11:30 do not collide (matches `overlaps()`).
- **Time zone:** all times are stored and compared in **UTC**. The clinic's time zone is used only to display, to validate opening hours, and to split "today". Morocco's offset changes (Ramadan), which is why nothing is stored as local time. The importer converts the frontend's ISO instants.
- **Concurrent booking:** two requests claim the same dentist/chair/patient slot → exactly one INSERT succeeds; the other gets 1062 and the API returns `409 conflict` with *which* resource clashed (found by a follow-up read).
- **Create:** (1) generate the appointment id; (2) claim slots; (3) insert the appointment row; (4) on any failure after step 2, delete claims for that id. A crash between 2 and 3 leaves **orphan claims**: they over-block (safe), never double-book, and a sweep deletes claims whose appointment does not exist after 5 minutes.
- **Reschedule / reassign (dentist, chair, time):** the new range may overlap the old one *of the same appointment*, which a plain INSERT would reject. Two candidate methods, both to be tested on TiDB:
  1. one **transaction**: delete this appointment's claims, insert the new ones, update the row (clean, needs `begin()` to behave);
  2. **claim-new-first**: `INSERT … ON DUPLICATE KEY UPDATE appointment_id = IF(appointment_id = VALUES(appointment_id), appointment_id, NULL)` — rows already owned by the same appointment pass, a foreign owner forces a NOT NULL violation — then update the appointment, then delete the claims that fall outside the new range. A failure leaves extra claims (over-blocking), never a double booking.
  Choice depends on the transaction tests (section 5).
- **Release:** `cancelled` and `no-show` delete the claims (they are not active). `completed` keeps them (it is active in the frontend); a nightly job deletes claims older than N days. **Reinstating** (`cancelled → scheduled`) re-claims and can fail with 409 because the slot was taken meanwhile — same as the frontend rule.
- **Patient conflicts** use the same table (`resource_kind = 'patient'`), which is why the frontend's third check is not lost.
- **Compatibility:** the API still returns the frontend's `ApiResult` conflict shape (`code: 'conflict'`, `details[]`). The frontend's own `findConflicts` stays as instant feedback and is not removed.

### What must be demonstrated against TiDB (test T7–T10, section 5)

N parallel creates of the same slot → exactly one wins; adjacent slots → both win; reschedule into own old range; cancel then immediate rebook; concurrent reinstate vs new booking; crash simulation (kill between steps) → no double booking, orphans swept.

---

## 5. TiDB transaction and driver test plan

I cannot run these here (section 0). Each is a script in `tests/tidb/`, run with `TIDB_DATABASE_URL` against a **scratch database** (never `dontalist` production data), by you locally or by me through a deployed test Worker. Results get written to `docs/tidb-test-results.md`; nothing is declared supported until its row says PASS with a date and driver version.

| # | Test | Pass condition |
|---|---|---|
| T0 | `SELECT 1`; `SELECT VERSION(), @@tidb_txn_mode, @@transaction_isolation, @@tidb_enable_check_constraint`; create two tables with a composite FK and try a cross-parent insert | connection works over HTTPS; we record the real isolation, mode, FK and CHECK behaviour |
| T1 | stateless autocommit write then read | durable and visible |
| T2 | `begin → insert → commit` | row visible after commit only |
| T3 | `begin → insert → rollback`; and throw before commit | row absent; no leaked lock |
| T4 | two interleaved transactions updating the same row (optimistic/pessimistic behaviour) | one waits or fails with a retryable code (1213/1205/9007 write-conflict); never a lost update |
| T5 | 50 parallel `UPDATE counter = counter + 1` (stateless and in transactions) | final value 50 |
| T6 | version-checked `UPDATE … WHERE id=? AND version=?` ×20 parallel | exactly one wins |
| T7 | 20 parallel slot-claim INSERTs for one slot | exactly one succeeds, 19 get 1062 |
| T8 | multi-row INSERT where the last row collides | zero rows inserted (statement atomicity) |
| T9 | reschedule into own old range by both methods (section 4) | succeeds for the owner, fails for a stranger |
| T10 | create → force failure after claiming → sweep | no double booking; orphan swept |
| T11 | gap-free invoice number: 20 parallel issues with `INSERT … SELECT MAX+1` + retry on 1062 | 20 distinct, gap-free numbers |
| T12 | failure injection: abort the HTTP request mid-transaction (cancel `fetch`) and wait | transaction does not commit; lock released within the timeout; record how long |
| T13 | statements run in parallel inside one transaction (documented as forbidden) | confirm the failure mode so code can never do it |
| T14 | isolation: `READ COMMITTED` vs `REPEATABLE READ` read-your-writes during concurrent commit | document which the API uses per operation |
| T15 | result cap: query returning > 10,000 rows | confirm error or truncation; pagination keeps every query far below it |

**Decision rule.** Where a test shows `begin()` is safe, multi-step operations (issue invoice with lines, post payment, void with reason + audit event) use it. Where it fails or is flaky, the operation is redesigned as **single statements with unique keys and version checks** (as in section 4), with the table of limitations published. The money rules (an invoice immutable, a payment voided never deleted, gap-free numbers) are designed so a half-finished sequence is **detectable and harmless**: e.g. an invoice row is written `status='issuing'` first and flipped to `issued` last; a sweep finishes or voids stragglers.

---

## 6. API resource structure

Base `https://api.dontalist.com/api/v1`. JSON. Every route: session → CSRF → permission → clinic scope. `Role` columns show who gets the default permission; the owner's overrides apply on top.

**Pagination convention (mandatory).** `?limit=` default 25, max 100. Lists that grow (patients, appointments history, invoices, payments, documents, audit) use **keyset cursors**: `?cursor=<opaque>` over `(sort_col, id)`; the response is `{ items, next }`; **no total count by default** (`?count=1` opt-in, capped/approximate). Small admin lists (staff, chairs, templates) may return everything up to a hard cap. The calendar and reports **require** `from` and `to` (max 62 days). Selected columns only; no `SELECT *`.

| Resource | Endpoints | Permission (area.action) |
|---|---|---|
| **Auth** | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/password`, `POST /auth/reset` (redeem) | public / session |
| **Staff** | `GET /staff`, `POST /staff`, `GET/PATCH /staff/:id`, `POST /staff/:id/status` (suspend/reactivate/deactivate + revoke), `PUT /staff/:id/permissions`, `POST /staff/:id/reset-link`, `GET/PUT /staff/:id/dentist-profile` | team.* ; own profile: profile.* |
| **Clinic** | `GET/PATCH /clinic` (identity, hours, currency, timezone), `GET/PATCH /clinic/public-profile`, `/chairs`, `/catalog` (procedures + prices) | settings.*, profile.* |
| **Patients (core)** | `GET /patients?q=&archived=&cursor=` (list), `POST /patients`, `GET/PATCH /patients/:id` (core fields only: identity, contact, alert, photo ref), `POST /patients/:id/archive`, `…/restore` | patients.* |
| **Patient sections** (each loaded on its own) | `GET/PUT /patients/:id/medical`, `/insurances`, `/allergies`, `/medications`, `/whatsapp-consent` | patients.* / clinical.* |
| | `GET /patients/:id/plan` (+ `POST/PATCH/DELETE` items), `/proposals`, `/visits` (+ revisions), `/letters`, `/messages` (cursor lists) | clinical.* ; messages: patients.* |
| **Dental charts** | `GET/PUT /patients/:id/chart/working` (the odontogram **and** periodontogram live in the one versioned payload, validated by structure/version on write), `GET /patients/:id/exams?cursor=` (list **without** payload), `GET /exams/:id` (payload), `POST /patients/:id/exams` (freeze working chart), `POST /exams/:id/sign` , `POST /exams/:id/void` (reason), `POST /exams/:id/correct` (new version), `POST /patients/:id/chart/recover` | clinical.* (`approve` signs, `void` voids) |
| **Appointments** | `GET /appointments?from=&to=&dentistId=&patientId=`, `POST`, `GET/PATCH /appointments/:id` (move, reassign), `POST /appointments/:id/status`, `GET /appointments/:id/history` | appointments.* |
| **Invoices** | `GET /invoices?cursor=&patientId=&status=`, `POST /patients/:id/invoices` (issue from done acts), `GET /invoices/:id` (with lines), `POST /invoices/:id/cancel` (credit note + reason) | billing.* (`approve`/`void` accountant & owner) |
| **Payments** | `GET /payments?cursor=&from=&to=`, `POST /patients/:id/payments`, `POST /payments/:id/void` (reason) | billing.* |
| **Balance** | `GET /patients/:id/balance` (derived by query: done work − non-voided payments, never stored) | billing.view |
| **Prescriptions** | `GET /patients/:id/prescriptions?cursor=`, `POST` draft, `PATCH` draft, `POST /prescriptions/:id/issue` (needs `clinical.approve`), `POST /prescriptions/:id/void`; `GET/POST/PATCH /rx-templates`, `/medications`, `/allergy-defs` (clinic libraries) | clinical.* ; libraries: practice.* |
| **Documents / files** | `GET /patients/:id/documents?cursor=` (metadata), `POST /files` (stream upload), `GET /files/:id/content` (stream download), `DELETE /files/:id` (soft) | clinical.* |
| **Practice** | `/expenses`, `/stock`, `/lab-orders`, `/tasks`, `/implants`, `/sterilization` (all cursor lists, date-filtered) | practice.*, tasks.* |
| **Reports** | `GET /reports/revenue?from=&to=`, `/reports/appointments?…`, `/reports/doctors?…` computed in SQL, bounded ranges | reports.view |
| **Audit** | `GET /audit?cursor=&entity=` (read only) | settings.manage |
| **Import** | `POST /imports`, `PUT /imports/:id/batches/:entity`, `POST /imports/:id/verify`, `GET /imports/:id` (section 7) | owner only |
| **System** | `GET /health`, `GET /health/deep` (DB reachable) | public |

Why the patient is split this way: the screens that open one tab (medical, plan, billing, prescriptions, documents, each chart) fetch only that section; the patient header uses the core endpoint plus `GET /patients/:id/summary` (alert, balance due, next appointment, counts), a single small query, so the profile no longer needs the whole record.

Consistency rules the API enforces and the frontend already assumes: an invoice is immutable once issued (cancel = credit note); a payment is never deleted (void with reason); signed exams are immutable (correct = new version); letters and messages are append-only; every one of these writes an audit event.

---

## 7. IndexedDB → TiDB migration plan

**Source:** the frontend's existing, versioned `BackupFile` (`services/backup.ts`, with a full-clinic round-trip test): locations, dentists, chairs, patients (with all nested arrays), appointments, catalog, practice stores (`expenses, stock, lab, tasks, implants, steril`), documents (bytes as data URLs), and settings (prefs, templates, `staff` + `staffLog`, medication / allergy / Rx libraries, insurance providers).

**Principle:** the importer **adds**, never overwrites, and never touches the browser's IndexedDB. The local copy stays until the owner confirms the verified summary.

1. **Preflight (browser, no network).** Validate the file against the models; list problems per record (bad dates, off-grid appointments, unreadable charts via `readChart`, orphan references: appointment → missing patient/dentist/chair, payment → missing invoice, credit note → missing original). Show the report; the owner decides what to do. Nothing is "fixed" silently.
2. **Dry run (server).** `POST /imports` with `dryRun`: the server checks the same rules, duplicate ids already in TiDB, and email clashes, and returns counts + the problem list. Writes nothing.
3. **Staff mapping.** The frontend has two separate lists: local PIN `staff` (auth) and calendar `dentists`. They are not linked by an id (unverified). The owner links each person; a dentist with no account becomes a profile-only staff row. Local PINs are **not** migrated (they are local unlock secrets); each person receives a reset link to set a password.
4. **Commit in dependency order, in batches** (≤ 200 records, idempotent): clinic settings → staff & dentist profiles → chairs → catalog & libraries → patients → patient sections (medical, insurances, allergies, medications) → appointments (+ slots) → plan, proposals, visits → exams & chart → invoices (numbers preserved; counters set to the highest per kind/year) → payments → letters, messages → prescriptions → practice stores → document metadata + bytes (streamed to R2 one at a time, never all in memory).
5. **Idempotency and duplicates.** Each record keeps its **id**. Same id and same content hash → skipped as "already imported" (safe retry). Same id, different content → **conflict**, reported, never overwritten. Original `createdAt`/`at` timestamps are kept; an `imported_at` column records the import.
6. **Referential integrity.** Records whose parent is absent are held back and reported, not inserted with a dangling link. After commit, integrity queries run (every child has its parent in the same clinic; every payment's invoice exists; every credit note's original exists; slot claims match active appointments).
7. **Verification.** Per entity: source count = imported + skipped-identical + reported; checksums of money (sum of invoices, payments, plan) match between file and database; a sample of patients is re-read through the API and compared field by field. The summary is stored in `import_job.summary` and shown to the owner.
8. **Interruption and recovery.** `import_job(id, clinic_id, status, cursor_entity, cursor_offset, summary JSON)`. A dropped connection resumes from the cursor; re-sending a batch is harmless (idempotent). A failed job can be **abandoned**; imported rows carry `import_job_id`, so an owner-approved rollback can remove exactly those rows (never other data). No production destructive step runs without explicit approval.
9. **Cut-over.** After verification and owner confirmation, the browser switches from local to API mode and keeps IndexedDB as a read cache (section 9). The original backup file is offered for download first.

**Documents** are the largest risk: data URLs in the backup are base64 inside JSON. The importer reads them from the file one at a time, converts to a `Blob`, and streams it to `POST /files` with the original id/metadata. A 200 MB backup must never be parsed as one object in the Worker; batches carry metadata only.

---

## 8. Infrastructure and performance plan

**Deployment.** Two Workers (Paid plan): `dontalist-api` (Hono, custom domain `api.dontalist.com`) and the Angular SSR Worker (`dontalist.com`, service binding `API`). Wrangler config in each repo, `nodejs_compat` **off** unless a dependency proves it needs it (the API's own dependencies are Hono and `@tidbcloud/serverless`; the Angular entry needs none). Environments: `dev` (local, `.dev.vars`, scratch TiDB database + dev R2 bucket), `staging`, `production`. Staging uses a separate TiDB database (not the `sys` database; production uses `dontalist`).

**Secrets** (Worker secrets, never in git): `TIDB_DATABASE_URL`, `PASSWORD_PEPPER`, optional `GOOGLE_MAPS_SERVER_KEY`, R2 S3 credentials only if presigned uploads are adopted. Non-secret config in `vars`: allowed origins, cookie domain. No TiDB username or password has been given to me or written anywhere in this repository.

**TLS to TiDB.** The driver uses HTTPS to the TiDB Cloud HTTP gateway; the Worker validates it with Cloudflare's trust store. There is no CA file to install and certificate verification is never disabled. (Verified for the transport; the exact gateway hostname the driver derives from `gateway01…` is confirmed by test T0.)

**Connection check (first action after approval).** Run T0 from your machine (`wrangler dev` with a `.dev.vars` you create), then from the deployed Worker. Do **not** paste the TiDB password into chat. Use a dedicated least-privilege database user for the API (no DDL), and a separate migration user.

**R2 and files.** A private bucket, no public URL. Keys are `c/<clinic_id>/<random>`; the client never supplies a key or clinic. Metadata (id, patient, kind, name, size, sha-256, uploader) lives in `file_object`.
- *Upload — V1 recommendation:* **stream through the Worker** into the R2 binding (`bucket.put(key, request.body)` with a declared `Content-Length`, max 15 MB, JPEG/PNG/PDF only). It is not buffered, needs no S3 credentials, and keeps authorization in one place. After the write the Worker reads the first bytes with a ranged `get` and deletes the object if the magic bytes do not match the declared type.
- *Presigned direct upload (what you asked for "where appropriate"):* worth it only for large files (full-mouth CBCT scans, video). It needs R2 S3 keys as secrets, bucket CORS, a signing library (`aws4fetch`, Web-Crypto based), a two-step init/confirm, and a post-upload check, because a presigned PUT cannot inspect content. I propose **not** to build it for V1 and revisit if a file type above ~50 MB is approved (D5).
- *Download:* streamed through the Worker after the clinic and permission check (`Content-Disposition: attachment`, `nosniff`, `no-store`), or a short-lived signed GET if bandwidth through the Worker becomes a problem.
- Request-size caps on every route; JSON bodies limited (charts ≤ 512 KB).

**Latency (nothing assumed; all measured).**
- The endpoint is **AWS us-east-1**. A request from Morocco to a Worker is served near the user; if that Worker then makes several sequential TiDB queries to Virginia, each costs a transatlantic round trip. Two mitigations, to be measured against each other: (a) `placement.region = "aws:us-east-1"` on the API Worker (the user pays one round trip, the database round trips are short); (b) a TiDB Cloud region closer to Morocco if your tier offers one (`ticloud serverless region`). Assumption (unmeasured): a Europe region would be markedly closer to Morocco than Virginia.
- Also to weigh: data-residency expectations for Moroccan patient data (CNDP / law 09-08). **This is a legal question I cannot answer**; it can decide the region regardless of latency (D3).
- Design to keep round trips low regardless: one query per list, joins instead of N+1, no per-row queries, `arrayMode` for large rows, patient summary as one query.

**CPU and memory.**
- Benchmark on a **deployed** Worker (not `wrangler dev`): login (PBKDF2), authenticated read, patient list/search, calendar week, patient summary, create appointment (slot claim), issue invoice, file upload/download. Record CPU ms per request from Workers observability and wall time from the client.
- Load: 10, 25 and 50 concurrent users, each running a scripted realistic mix for several minutes, from an Africa/Europe vantage point and from a US one. Report p50/p95/p99 latency, error rate, and Workers CPU.
- **Memory:** the 128 MB is per isolate and shared by concurrent requests. I am not aware that Cloudflare exposes per-isolate memory in its dashboard (**unverified**), so the plan is: measure heap locally with the inspector under the same load, keep all responses and uploads bounded/streamed (no result set > 100 rows, no body > cap), and treat "zero *exceeded memory* errors" in production logs as the live signal. Your targets (typical < 64 MB, p99 < 96 MB, zero errors, API < 500 ms) are used as pass criteria for the local heap measurements and the latency numbers; the report will say which were measured where, and nothing will be called "met" where it was not measured.
- Cloudflare Cron Trigger: nightly sweep (orphan slot claims, expired sessions/reset tokens, old completed-appointment claims).

---

## 9. Frontend data access and offline (for later, needs approval before touching the frontend)

The frontend repository is **not changed** by this proposal. When approved, the minimal change is a repository interface behind the existing store methods (`DentalStore`), with an API implementation next to the current IndexedDB one:

- Reads go to the API, are paginated, and are cached in IndexedDB by `(resource, id)` with a timestamp; selected recent views (today's appointments, recently opened patients, the open patient's sections) stay readable offline.
- Writes require connectivity. Offline, the UI shows read-only data with a clear banner. No queue, no merge logic in V1.
- The repository boundary and the `version` field on every mutable resource are the only things added now so a later sync can be built without rewriting screens.
- The existing local PIN lock stays as a screen lock after full sign-in.
- The heavy screens that call `getAll()` today (patient list, calendar, today, reports, doctor stats) move to range/page queries; that is the largest frontend change and is planned separately.

---

## 10. Database schema and migration strategy

**Dialect rules:** MySQL/TiDB only; `utf8mb4`; `DECIMAL(12,2)` for money (the driver returns it as a **string**, the API converts to a JSON number because the frontend uses whole units; checked against precision limits); `DATETIME(3)` in UTC (a string from the driver, converted in one place); `JSON` only for genuinely flexible payloads (chart payload, structured medical history, template bodies, settings); everything filtered, joined or sorted is a real indexed column. **No** triggers, procedures, `CHECK` reliance (validation is in the API; `CHECK` is added only if T0 shows it is enforced), no `ENUM` (adding a value needs DDL; `VARCHAR` + API validation), no PostgreSQL syntax. `AUTO_INCREMENT` is not used (ids are client/UUID, and TiDB's auto-increment is not sequential).

**Tables (all clinic-owned ones carry `clinic_id` and are keyed `(clinic_id, id)` unless noted):**

| Group | Tables |
|---|---|
| Tenant & identity | `clinic`, `staff`, `staff_permission`, `dentist_profile`, `auth_session`, `password_reset`, `audit_event`, `import_job` |
| Setup | `chair`, `catalog_entry`, `insurance_provider`, `medication_lib`, `allergy_def`, `rx_template`, `clinic_public_profile`, `clinic_setting` (JSON by key: prefs, templates) |
| Patient | `patient`, `patient_medical` (JSON, 1:1), `patient_insurance`, `patient_allergy`, `patient_medication` |
| Scheduling | `appointment`, `appointment_slot`, `appointment_status_change`, `appointment_schedule_change`, `invoice_counter` |
| Clinical | `chart_working` (patient, JSON payload, `payload_version`, `version`), `exam` (frozen payload JSON, status, signed/voided by + reason, `supersedes_id`), `chart_recovery`, `plan_item`, `proposal`, `visit_note`, `visit_note_revision`, `letter`, `message`, `prescription` (+ frozen snapshot JSON) |
| Billing | `invoice`, `invoice_line` (frozen), `payment` |
| Files | `file_object` |
| Practice | `expense`, `stock_item`, `lab_order`, `task`, `implant_record`, `sterilization_cycle` |

Where each frontend field goes is derived from `src/app/denteus/models/dental.models.ts` and `docs/domain-model.md` ("Persistence inconsistencies to fix"): the patient's nested arrays become child tables; money totals are not stored (balances are queries); invoice and payment immutability is by status columns; `createdBy`/`voidedBy` are added (the frontend did not record authors on payments, invoices, voids).

**Chart payloads** stay versioned JSON exactly as the engine writes them (`PAYLOAD_VERSION`); the server validates structure, size and version, and refuses payloads the same engine rules mark as lossy. The server does **not** import the frontend's engine (different repository); a small, versioned **JSON Schema** of the payload plus a shared fixtures contract test is the proposed bridge (D2).

**Identified incompatibilities (reported, not silently translated):**
1. `db/d1-sketch` and `db/postgres-superseded` in the frontend repo are obsolete (triggers, GLOB, partial indexes, `jsonb`, RLS). They are not reused.
2. My earlier prototype schema (`dental/db/migrations/0001_core.sql`) uses 26-char ids, `ENUM`, a single appointment-per-resource check and no slot table; it is replaced, not ported as is.
3. The frontend has `locationId` on several records; one clinic = one location, so it is dropped.
4. Frontend money is whole units (`number`); stored as `DECIMAL(12,2)`, returned as numbers.
5. Frontend appointment times are JS `Date`s (UTC instants once serialised); the 5-minute grid is **new** and must be checked against real data.
6. The frontend stores perio data inside the single chart payload, while the product has two charts; the API treats it as one versioned payload and the frontend continues to render two views (to confirm with you, D2).
7. `Staff` (local PIN accounts) and `Dentist` (calendar) are unlinked in the frontend; the importer needs the owner to link them.

**Migration strategy.** Numbered forward-only files `db/migrations/NNNN_name.sql`, applied by a small script using the **same** `@tidbcloud/serverless` driver (no other migration tool), recording name + SHA-256 in `schema_migration`; a changed applied file aborts. A `--check` mode validates naming, forbidden statements (triggers/procedures/`CHECK`/destructive DDL without an explicit marker) offline in CI. TiDB DDL is not transactional, so each file is small and a failed one is repaired by a **new** migration. Migrations run with a dedicated DDL user, never the runtime user, never against production without your explicit approval.

---

## 11. Security and testing strategy

| Area | Tests (run in CI; "TiDB" rows need the real cluster) |
|---|---|
| **Tenant isolation** | for **every** resource: a valid session of clinic B requests/changes/deletes clinic A's record by id, by list, by search, with a spoofed `clinic_id`, and as a related id inside a body (patient, dentist, chair, invoice, file) → 404/422, never 200; composite-FK backstop (T0); the "every query in the repository layer carries `clinic_id`" static check (prototype has it) |
| **Roles/permissions** | table-driven test: for each of the 6 roles × every route, expected allow/deny from the copied permission table; override (extra/removed) applied live; owner-only permissions; contract test against the frontend's `auth-rules` |
| **Authentication** | wrong/unknown account same response; lockout; suspension and deactivation effective next request; session expiry (idle, absolute); revocation on logout/password change/reset; reset token single-use and expiry; cookie flags per environment; CSRF missing/wrong, Origin not allowed; CORS preflight for allowed and disallowed origins; PBKDF2 timing benchmark deployed |
| **Input validation** | every body has a schema; length, type, enum, date and ID format; oversized body → 413; unknown fields ignored (never mass-assigned); parameterised SQL only (a static check forbids string-built SQL) |
| **Pagination** | limit default/cap, cursor tamper, deterministic order with duplicate sort keys, boundary pages, empty page, date-range max, no endpoint can return more than 100 rows (except capped small lists) |
| **Clinical integrity** | signed exam immutable; correction = new version; void needs reason, row kept; lossy/unreadable chart refused; audit event written for each clinical action; the audit table has no update/delete path in code |
| **Financial integrity** | invoice immutable; cancel issues a credit note; gap-free numbers under concurrency (T11); payment never deleted, void keeps row and is excluded from balances; derived balance equals sum of rows; money round-trips as exact |
| **Concurrency** | T4–T11 against TiDB; slot-claim tests; version-conflict (409) tests |
| **Files** | type + size + magic-byte checks; key not guessable and never returned; cross-clinic download denied; streaming without buffering (memory stays flat for a 15 MB upload under load) |
| **Errors/logging** | no SQL, stack or secret in any response; structured logs without PII or credentials |
| **Migration** | dry-run/commit/retry/interrupt/duplicate/conflict/orphan scenarios on fixture backups, including the biggest realistic clinic |

Honest limits: I have run **none** of these against TiDB. In the earlier prototype only logic-level tests ran, on an in-memory SQLite stand-in that proves nothing about TiDB's dialect or concurrency. The new test suite will run against Workers' runtime (`@cloudflare/vitest-pool-workers`) for HTTP/permission logic, and against the real scratch TiDB for anything involving SQL, transactions or concurrency; the report will say which suite each result came from.

---

## 12. Decisions still needed from you

| # | Decision | My recommendation |
|---|---|---|
| D1 | Session cookie scope (section 2) | **Option A**: `Domain=dontalist.com`, `__Secure-` prefix; no untrusted subdomains ever |
| D2 | Chart payload bridge across repos; one payload with perio inside vs two stored charts | Versioned JSON Schema + shared fixtures contract test; keep one payload, two views |
| D3 | Database region and data residency (Morocco law 09-08 / CNDP) | Decide the legal requirement first; then measure us-east-1 against any EU region your tier offers before choosing |
| D4 | Transactions policy | Decide per operation after T0–T15; default to single-statement + unique-key designs for slots and invoice numbers |
| D5 | Presigned direct uploads | Not in V1; stream through the Worker, 15 MB cap; revisit for files > 50 MB |
| D6 | 5-minute slot grid and rejecting off-grid times | Yes, after checking real backups; the importer reports off-grid items |
| D7 | Staff ↔ dentist linking at import; no PIN migration; reset links | As described in section 7 |
| D8 | Per-IP login throttling mechanism | Cloudflare rate-limiting rule (needs your plan's feature check) |
| D9 | Session lifetimes (idle/absolute) | 8 h idle / 14 d absolute is common for desk staff; the prototype's 2 h / 12 h is too short for a clinic day; your call |
| D10 | Practice modules (expenses, stock, lab, tasks, implants, sterilization) | Include in V1 scope after clinical/billing, as simple tables |

### Proposed order of work (each step small, tested, then reviewed)

0. **Connection and driver tests** T0–T15 (needs your `.dev.vars`; no feature code).
1. Foundation: Hono app, bindings, error envelope, pagination helper, session/CSRF/CORS/permission middleware, test harness, migration runner.
2. Auth and staff. 3. Patients core + sections. 4. Calendar (chairs, dentists, appointments, slot claims). 5. Charts and exams. 6. Billing (after T11–T14). 7. Prescriptions, libraries, files/R2. 8. Practice modules and reports. 9. Import tool. 10. Frontend repository layer (separate approval).

### Risks, stated plainly

1. `begin()` is experimental and not concurrency-safe inside one transaction; the design avoids needing it for the hardest invariants.
2. The slot-claim design is sound on paper and unproven on TiDB; T7–T10 decide it.
3. Latency from Morocco to us-east-1 is unmeasured; it can dominate the user experience.
4. PBKDF2 CPU on Workers is unmeasured on the deployed platform.
5. The IndexedDB import touches clinical and financial history; its verification step is not optional.
6. Two repositories mean the permission table, the chart payload and the error shapes can drift; contract tests are the only guard.
7. A Neon password pasted earlier in this project (provider since dropped) is still exposed and must be rotated. For TiDB, keep credentials out of chat and use a least-privilege runtime user.

---

## 13. Review outcomes (supersedes earlier sections where they differ)

Evidence levels: **Source** = read in `@tidbcloud/serverless` 0.3.0; **Docs** = vendor docs; **Local** = run in local workerd or the node:sqlite stand-in (NOT TiDB); **Unverified** = nothing run. No test has been run against TiDB: the sandbox cannot reach it.

### 1. Confirmed and safe
- No `nodejs_compat` needed (app builds and runs in workerd without it). *Local*
- Server-side opaque sessions (SHA-256 of token stored), re-validated on every request; suspended staff and revoked/expired/idle sessions are rejected. *Local, 9 tests*
- Exact-origin CORS from config, Origin + CSRF-header on every mutation, 64 KB streamed body cap. *Local*
- Permissions are a verbatim copy of the frontend rules; a contract test fails on drift. *Local*
- Money in BigInt minor units; DECIMAL arrives as a string from the driver, never a float. *Source + Local*
- Pagination: default 25, max 100, invalid values rejected (not clamped), keyset cursor, `limit+1` instead of COUNT. *Local*

### 2. Corrected during the review
| Was | Now |
|---|---|
| PBKDF2 100,000 iterations | Below OWASP (600,000 for SHA-256). Now 6 chained rounds × 100,000 (= 600,000 cost), versioned `pbkdf2$100000x6$…`, pepper, rehash on login. Chained because a deployed Worker may cap one call at 100,000 (local workerd accepts 600,000 in ~80 ms). Argon2id via `hash-wasm` fails in workerd (runtime Wasm compile disallowed); needs a precompiled `.wasm` import. |
| Cookie `Domain=dontalist.com` (Option A) | Default host-only `__Host-dl_session` on the API host. Name, domain, Secure, SameSite all configurable; unsafe combinations (`__Host-` with Domain, `None` without Secure) refuse to start. |
| "Driver uses prepared statements" | **It does not.** `?` is interpolated client-side. SQL must contain no literal `?`; we assert placeholders == params (`checkPlaceholders`). Residual risk: depends on server not using `NO_BACKSLASH_ESCAPES` (T0 checks `@@sql_mode`). |
| "Driver has timeouts" | It has none. We pass a custom `fetch` with `AbortSignal.timeout(8s)`. |
| Lockout SQL `SET failed_logins=failed_logins+1, locked_until=CASE WHEN failed_logins+1…` | MySQL evaluates SET left to right, SQLite does not: the same text meant different things (off by one in MySQL). Assignment order now makes both agree. |
| Slot claims: sweep deletes orphan claims | Race: it could delete claims of an appointment still being created. Design: insert appointment row first as `booking`, then claims, then flip live; sweep only deletes claims whose appointment is missing AND older than a lease. Reschedule claims only delta slots, version-checked UPDATE is the arbiter, then verify claim count, delete old-only slots by exact key. No `ON DUPLICATE KEY` trick. |
| Invoice numbers "gap-free via MAX+1 + retry" | Cannot be guaranteed under failures; not claimed. Proposal: unique per clinic+kind+year, issued in the same step as the invoice; a failed issue may leave a gap, which is recorded, never reused. See decisions. |

### 3. Requires a real TiDB integration test (T0–T15, `tests/tidb`, not yet written/run)
Multi-row INSERT atomicity (slot claims); concurrent double-booking (T7–T10); behaviour of `begin()` under timeout/abort; CHECK/FK enforcement on the target version; composite FKs; `@@sql_mode`; DECIMAL/DATETIME/JSON round-trip; 10,000-row cap; unique-key error text for 1062 mapping; cascade behaviour; invoice-number concurrency (T11); Worker→TiDB latency, Smart Placement, 10/25/50-concurrency load and P50/P95/P99 on a deployed Worker; PBKDF2 600,000 single-call on a deployed Worker.

### 4. Needs a decision from the owner
1. **Plain-text passwords were requested and declined.** Hashing stays. Operator access is `npm run set-password -- <email>` (new random password, sessions revoked), so any clinic is always reachable without knowing anyone's password.
2. Invoice numbering policy (gap-tolerant unique numbers vs. a stricter scheme). The frontend text says gap-free.
3. How Angular SSR learns the session with a host-only API cookie (SSR does not see the API host's cookie). Options: SSR does no authenticated rendering (client-side data after login, recommended); or an SSR-host session cookie.
4. Hosting region vs. Moroccan Law 09-08 / CNDP: legal confirmation needed; do not load real patient data into us-east-1 until confirmed. Dev/staging only meanwhile.
5. Session lifetimes (default idle 2 h, absolute 12 h; configurable).
6. The 5-minute grid: needs real frontend backups to check for off-grid historical appointments; the importer must report them, never move them.
7. **Credential hygiene:** the previously exposed Neon password must be rotated; use least-privilege runtime vs. migration users.

### 13b. Scheduling pass (feat/scheduling)
`db/migrations/0002_scheduling.sql` (patient core, chair, dentist_profile, appointment with `live` + `version`, appointment_slot, status history) and `src/appointments/slots.ts` implement the corrected slot design: create (row live=0 → claims → count check → live=1), move (delta claims → version-checked UPDATE → exact-key release), status change (release / re-claim), `sweepStale` (lease, never touches live appointments). Off-grid times are rejected, not moved. 13 logic tests pass on the SQLite stand-in only. `tests/tidb/slots.test.ts` (sql_mode, duplicate-key mapping, multi-row INSERT atomicity, 20-way concurrent booking, DECIMAL/DATETIME round-trip) is written but **has not been run**: set `TIDB_TEST_URL` (scratch DB) and run `npm run test:tidb`. Known gap: no reconcile job for claims left by a crash mid-move (over-blocks only); HTTP endpoints for appointments are the next pass.

### 13c. Appointment API (feat/appointment-api)
`GET /v1/appointments` (mandatory UTC date range, max 62 days, keyset cursor, limit 1–100), `POST /v1/appointments`, `POST /v1/appointments/:id/reschedule` (requires `version`), `POST /v1/appointments/:id/status`. Permissions: `appointments.view` / `.create` / `.edit`. Patient, dentist and chair ids are checked against the caller's clinic before use. Conflicts return 409 `slot_taken`, stale versions 409 `stale`, off-grid/duration/transition errors 422. 6 API tests on the SQLite stand-in; not run on TiDB. The frontend repository layer is not changed; this is the contract it will call.

### 13d. Patients and clinic bootstrap (feat/patients-bootstrap)
`GET/POST /v1/patients`, `GET/PATCH /v1/patients/:id`, `POST /v1/patients/:id/archive` (core record only; clinical sections come later as separate endpoints). Search is a prefix match on `full_name_norm` (lowercase, accent-free, maintained by the API) so results never depend on the DB collation (TiDB's default is case-sensitive); keyset pagination on `(full_name_norm, id)`; archived patients hidden by default; patients are archived, never deleted. Migration 0002 was edited in place (it has not been applied to any database yet; once applied, changes go in a new file). First clinic and owner: `npm run create-clinic -- "<clinic>" <owner@email> "<owner name>"` prints a temporary password once; there is no public sign-up endpoint. 6 more tests (49 total) on the SQLite stand-in; not run on TiDB.

### 13e. Billing (feat/billing)
Migration `0003_billing.sql` (+ `clinic.currency`, default MAD). Endpoints: `GET/POST /v1/patients/:id/invoices`, `GET /v1/invoices/:id`, `POST /v1/invoices/:id/cancel` (credit note), `GET/POST /v1/patients/:id/payments`, `POST /v1/payments/:id/void`, `GET /v1/patients/:id/balance`. Permissions: `billing.view`, `billing.create` (issue, record payment), `billing.void` (cancel invoice, void payment). Rules: invoices are never edited or deleted; credit notes carry negated lines and `cancels_id`; a conditional UPDATE on the original blocks double cancellation (and is reverted if the credit note fails); payments are voided with a reason, stay in history and leave every total; a payment can only settle an open invoice of the same patient and clinic; amounts are exact (BigInt minor units, decimal-string input/output, 3+ decimals or exponent forms rejected). **Contract change to confirm with the frontend:** money is returned as decimal strings (`"1500.00"`), not JS numbers, so nothing is rounded silently; the frontend adapter converts with `toWholeUnits` for its whole-unit UI. **Numbering:** `FA-/AV-YYYY-NNNN`, year in the clinic's time zone, unique per clinic+kind+year via the unique key with retry; gap-free is NOT claimed (a crash between header and lines leaves a dead header that keeps its number). Tests on the SQLite stand-in only (it sums DECIMAL as floats, so amounts there are exactly representable); not run on TiDB.

### 13f. Team and clinic resources (feat/team-resources)
`/v1/staff`: list (`team.view`), create (`team.create`, owner sets an initial password), patch name/jobTitle/role (`team.edit`), `PUT /:id/permissions` (`team.manage`; owner-only permissions are dropped server-side; owners' permissions cannot be edited), suspend/reactivate (`team.manage`; suspending revokes every session). `canManageRole` from the frontend rules is enforced on every change. **Last-owner rule:** a check before the change plus a re-count after it that reverts (a narrow race between two simultaneous demotions is therefore repaired, not impossible). `/v1/chairs` and `/v1/dentists`: read with `appointments.view`, change with `settings.edit`, archived not deleted. `POST /v1/auth/password` (current password required, signs out other sessions). Staff are never deleted (suspend keeps history). Every change writes an `audit_event`. 10 tests; stand-in only.

### 13g. Clinical sections (feat/clinical)
Migration `0004_clinical.sql`. All under `/v1/patients/:id/…` or by id, each loaded on demand: `medical` (GET/PUT with `expectedVersion`, 0 = first save), `chart` (the working odontogram/periodontogram payload, GET/PUT with `expectedVersion`), `exams` (append-only snapshots: POST, keyset list WITHOUT chart bodies, `GET /v1/exams/:id` with the chart, `POST /v1/exams/:id/void` with a reason; there is no edit or delete), `plan` (treatment items: POST, keyset list with `?status=`, `PATCH /v1/plan/:id` and `DELETE` only while planned; marking `done` freezes the item and the status guard is part of the UPDATE, so it cannot race). Permissions: `clinical.view/create/edit/void`; reception has none. **Chart validation is structural only:** object, ≤512 KB, `version` like "2.22", `teeth`/`plan` keys valid FDI numbers with object values, boolean `globals`; the payload is stored and returned exactly (JSON column) or refused, never rewritten. It has NOT been tested against payloads produced by the real chart engine: a fixture exported from the frontend (`writeChart(newChart())` plus a populated chart) must be added to `tests/` before the frontend switches over. The odontogram and periodontogram are one payload (periodontal data lives in the same tooth records and `case` metadata), so there is one chart store, not two. Scope/quadrant of a plan item cannot be changed in place (remove and re-add). 16 tests; stand-in only.
