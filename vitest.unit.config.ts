import { defineProject } from 'vitest/config'

/**
 * `unit` project：单元测试。
 *
 * 两条来源：
 *   1. 内置插件（`packages/**`）——测试与其覆盖的源码同目录、同名（`*.test.ts`）；
 *   2. 壳层自身的用例——`test/unit/**` 与 `src/**` 下与逻辑同名的 `.test.ts`。
 *
 * `test/archive/**` 是历史用例的归档（只读参考，不参与任何 project）。
 *
 * 并发与超时：`dsh-tauri-worktree` 的 operation.test 会创建真实 git 仓库
 * （clone/checkout/discard），全量并行时与其他文件的 git 操作竞争系统资源，
 * 偶发 5s 超时 flake；限制 maxWorkers 后单独复跑稳定通过。
 *
 * E2E 用例（`test/e2e/desktop` 与 `test/e2e/plugins` 下的 `.e2e.ts`）由
 * `vitest.desktop.config.ts` / `vitest.e2e.config.ts` 负责，本 project 不收。
 */
export default defineProject({
  test: {
    name: 'unit',
    include: [
      'packages/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}',
      'test/unit/**/*.test.ts',
      'src/**/*.test.ts',
    ],
    exclude: ['test/archive/**', 'archive/**'],
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
