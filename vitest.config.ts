import { defineConfig } from 'vitest/config'
// *.unit.test.ts need no database. *.pg.test.ts run against a REAL PostgreSQL (see tests/pg/setup.ts).
export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.ts'], globalSetup: ['tests/pg/setup.ts'], testTimeout: 30_000, hookTimeout: 120_000 } })
