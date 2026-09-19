import { defineProject } from 'vitest/config'

/**
 * `desktop` project：L3 桌面端 E2E（真实 Tauri 窗口）。
 *
 * 用例驱动真实 Debug 二进制：`@wdio/tauri-service` 的 embedded provider 自己拉起应用
 * （应用内嵌 W3C WebDriver server），vitest 负责组织用例与断言，不引入 WDIO runner。
 *
 * `fileParallelism: false`：应用固定占用 debug 端口 3081，且一次只应有一个实例；
 * 串行执行让「端口空闲 / 无残留实例」的前置校验始终成立。
 */
export default defineProject({
  test: {
    name: 'desktop',
    include: ['test/e2e/desktop/*.e2e.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
})
