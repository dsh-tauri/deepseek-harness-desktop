import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'desktop-heavy',
    environment: 'node',
    include: ['tests/e2e/heavy/**/*.e2e.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/target/**'],
    fileParallelism: false,
    testTimeout: 1_000_000,
    hookTimeout: 1_000_000,
  },
})
