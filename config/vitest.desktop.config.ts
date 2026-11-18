import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['tests/e2e/desktop/**/*.e2e.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/target/**'],
    fileParallelism: false,
    // 必须高于 tests/e2e/setup/shell.ts 的 ASSEMBLY_TIMEOUT_MS(900s)：否则装配还在等，
    // 用例级超时先把它切断，日志里只会看到 "Hook timed out"，掩盖真实原因。
    testTimeout: 1_000_000,
    hookTimeout: 1_000_000,
  },
})
