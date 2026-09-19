import { defineProject } from 'vitest/config'

/**
 * `e2e` project：插件 L2 E2E（真实 `dsh web` 进程）。
 *
 * 用例集中在 `test/e2e/plugins/`，与桌面端 L3 的 `test/e2e/desktop/` 平级；
 * 共享编排（`support/dsh-host.ts`）与 `global-setup.ts` 留在 `test/e2e/` 根下。
 *
 * `fileParallelism: false`：整个 project 共享一个真实 dsh 服务实例（由 globalSetup 起），
 * 串行执行让断言有意义，也避免多个 spec 同时打同一个服务。
 */
export default defineProject({
  test: {
    name: 'e2e',
    include: ['test/e2e/plugins/**/*.e2e.ts'],
    globalSetup: ['./test/e2e/global-setup.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
