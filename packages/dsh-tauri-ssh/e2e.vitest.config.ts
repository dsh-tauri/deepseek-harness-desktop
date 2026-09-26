import { defineConfig } from 'vitest/config'

/**
 * E2E runner: real network round trips (a reachable linux x64 SSH machine,
 * local unreachable ports, an in-process ssh2 protocol server). Deliberately
 * separate from the unit suite — `pnpm test` never picks these up.
 */
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    // One file at a time: the drop test owns the shared dev machine's
    // session processes and its remote port.
    fileParallelism: false,
  },
})
