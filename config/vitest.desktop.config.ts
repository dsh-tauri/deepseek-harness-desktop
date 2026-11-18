import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['tests/e2e/desktop/**/*.e2e.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/target/**'],
    fileParallelism: false,
    // 与 Rust lane 并发抢占同一台 runner，冷装配和首帧都会被拖慢；用例级上限必须
    // 明显高于 tests/e2e/setup/shell.ts 里单次等待的上限，否则正常启动会先被切断。
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
})
