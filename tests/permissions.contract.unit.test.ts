import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { ROLES, defaultsOf, OWNER_ONLY } from '../src/auth/permissions'

// Compares against the live frontend file when it is checked out next to this repo; skipped otherwise (CI without the frontend).
const FRONT = '../dental/src/app/core/auth/auth-rules.ts'
describe.skipIf(!existsSync(FRONT))('permissions match the frontend contract', async () => {
  const f = await import(/* @vite-ignore */ '../../dental/src/app/core/auth/auth-rules.ts')
  it('role defaults and owner-only are identical', () => {
    for (const r of ROLES) expect([...defaultsOf(r)].sort()).toEqual([...f.defaultsOf(r)].sort())
    expect([...OWNER_ONLY].sort()).toEqual([...f.OWNER_ONLY].sort())
  })
})
