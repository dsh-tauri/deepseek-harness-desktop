import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export default defineProject({
  test: {
    root,
    name: 'plugin',
    environment: 'node',
    include: ['packages/builtin-plugin-*/tests/e2e/*.e2e.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/target/**'],
    globalSetup: ['./apps/desktop/tests/e2e/support/setup-plugin.ts'],
    fileParallelism: false,
    testTimeout: 120000,
    hookTimeout: 120000,
  },
})
