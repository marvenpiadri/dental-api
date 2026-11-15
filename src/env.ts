/** Worker bindings. Secrets come from `.dev.vars` locally and `wrangler secret put` in deployed environments. */
export type Bindings = {
  TIDB_DATABASE_URL: string
  /** Defence-in-depth secret mixed into password hashes. Stored separately from the database. */
  PASSWORD_PEPPER: string
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
