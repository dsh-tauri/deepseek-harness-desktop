import { defineProject } from 'vitest/config'

/**
 * `e2e` project：插件 L2 E2E（真实 `dsh web` 进程）。
 *
 * 用例只放在各插件的 `test/` 目录下，统一命名 `*.e2e.ts`——`unit` project 的
 * `*.{test,spec}.*` 天然不收它，两边都不靠默认值。
 *
 * `fileParallelism: false`：整个 project 共享一个真实 dsh 服务实例（由 globalSetup 起），
 * 串行执行让断言有意义，也避免多个 spec 同时打同一个服务。
 */
export default defineProject({
  test: {
    name: 'e2e',
    include: ['packages/*/test/**/*.e2e.ts'],
    globalSetup: ['./test/e2e/global-setup.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
