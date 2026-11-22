# Temporary password hashing service

**Why:** Cloudflare Workers Free allows ~10 ms CPU per request; a safe Argon2id hash needs ~50 ms (19 MiB, WASM, which Workers cannot compile at runtime). Hashing therefore runs in a separate Neon Function. Nothing else moved.

## What / where
- Neon Function `pwhash`, project `red-meadow-47831446`, branch `br-cool-shadow-b94wwjrk`, Node 24, eu-central-1. Source: `password-service/` (hash-wasm 4.13.0, 13 KB zip). URL is in `.dev.vars` / Worker secrets, not here.
- Two endpoints: `POST /hash`, `POST /verify`. It knows no users, sessions, clinics or database (it never uses the injected `DATABASE_URL`) and logs nothing.

## Security
- Every request carries `HMAC-SHA256(secret, ts.POST.path.body)`; +-30 s skew, replay cache, constant-time compare, one identical 401. The secret is `HASH_SECRET` (function) = `PASSWORD_SERVICE_SECRET` (Worker secret); never in git.
- Limits: body 2 KB, password 512, 8 concurrent hashes (else 503). Fail closed: any outage/timeout (5 s) => API answers 503, never "wrong password", never counts toward lockout.
- The function URL is public HTTPS; only holders of the secret can get anything but 401. Rate limiting/lockout stay in the API. A verify call has to send the stored hash (self-describing, salted).
- Argon2id m=19456 KiB, t=2, p=1, NFKC-normalized; no pepper for new hashes.

## API side
`src/auth/password-service.ts` (`PasswordService.hash/verify`), `password.ts` (legacy PBKDF2 verify, verified locally, upgraded to Argon2id on next successful login with compare-and-set). No DB migration, no forced resets.

## Deploy / rotate
`cd password-service && npm ci && npm run build`, deploy `dist/function.zip` with `environment={"HASH_SECRET": ...}` (Neon `deploy_function`), then `wrangler secret put PASSWORD_SERVICE_URL` and `PASSWORD_SERVICE_SECRET`. Rotate: redeploy with the new secret, update the Worker secret.

## Removing it (move hashing back into the Worker)
1. Implement `PasswordService` in the Worker (Argon2id producing the same `$argon2id$` strings; needs Workers Paid CPU limits, or PBKDF2-WebCrypto with a new prefix handled in `verifyStored`), pass it as `passwords` in `createApp`.
2. Delete `password-service/`, the Neon function, `PASSWORD_SERVICE_*` secrets.
3. Once `SELECT count(*) FROM staff WHERE password_hash LIKE 'pbkdf2$%'` is 0, drop the legacy verifier and `PASSWORD_PEPPER`.

## Cost (confirm in the Neon console; not verified from here)
Neon Functions free allowance should cover a clinic's logins (each login = 1 call, ~50 ms compute). Workers Paid is $5/month flat but still cannot run this WASM; it only lifts the CPU limit.

## Measured
Local in-process: median 50 ms hash / 50 ms verify. Deployed latency, cold start and network overhead NOT measured: the sandbox egress proxy blocks the function host (403). Run `node` against the URL from a machine with internet.
