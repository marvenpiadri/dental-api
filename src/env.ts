/** Worker bindings. Secrets come from `.dev.vars` locally and `wrangler secret put` in deployed environments. */
export type Bindings = {
  /** Neon connection string, secret. Deployed: the POOLED (`-pooler`) host, runtime role. Local dev: any PostgreSQL. Never committed. */
  DATABASE_URL?: string
  /** Private R2 bucket, reached through its S3 API. Never public: uploads and reads use short-lived signed URLs issued after authorization. */
  R2_ENDPOINT?: string // https://<account>.r2.cloudflarestorage.com[/<bucket>]
  R2_BUCKET?: string // optional when the endpoint already ends with the bucket name
  R2_ACCESS_KEY_ID?: string // secret
  R2_SECRET_ACCESS_KEY?: string // secret
  /** Temporary Neon Function that hashes and verifies passwords (docs/password-service.md). Without both, sign-in fails closed. */
  PASSWORD_SERVICE_URL?: string
  PASSWORD_SERVICE_SECRET?: string // secret, 32+ characters, the same value as the function's HASH_SECRET
  /** Only to verify LEGACY `pbkdf2$` hashes until they have all been upgraded at login. Never used for new hashes. */
  PASSWORD_PEPPER?: string
  // Per-environment settings (wrangler.jsonc `vars`). Nothing here is hardcoded in code.
  APP_ORIGIN: string // e.g. https://dontalist.com
  API_ORIGIN: string // e.g. https://api.dontalist.com
  CORS_ORIGINS?: string // comma-separated exact origins; defaults to APP_ORIGIN
  COOKIE_NAME?: string // default "__Host-dl_session" (requires Secure, Path=/, no Domain)
  COOKIE_DOMAIN?: string // empty = host-only (recommended). Setting it disables the __Host- prefix.
  COOKIE_SECURE?: string // "false" only for http://localhost development
  COOKIE_SAMESITE?: 'Strict' | 'Lax' | 'None'
  SESSION_IDLE_MINUTES?: string
  SESSION_ABSOLUTE_MINUTES?: string
}
