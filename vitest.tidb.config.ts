import { defineConfig } from 'vitest/config'
// Real-cluster tests. Needs TIDB_TEST_URL pointing at a SCRATCH database (never production). Run: npm run test:tidb
export default defineConfig({ test: { environment: 'node', include: ['tests/tidb/**/*.test.ts'], testTimeout: 60_000, fileParallelism: false } })
