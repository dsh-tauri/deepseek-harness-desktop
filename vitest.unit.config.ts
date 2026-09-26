import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'

/**
 * `unit` project：单元测试。
 *
 * 两条来源：
 *   1. 内置插件（`packages/**`）——测试与其覆盖的源码同目录、同名（`*.test.ts`）；
 *   2. 壳层自身的用例——`test/**` 与 `src/**` 下与逻辑同名的 `.test.ts`。
 *
 * `test/archive/**` 是历史用例的归档（只读参考，不参与任何 project）。
 *
 * 排除项必须显式带上 node_modules 的通配：Vitest 一旦收到自定义 `exclude` 就**不再**
 * 合并默认值，而各插件包的 node_modules 下装着彼此链接的副本——不排除会把同一个
 * `index.test.ts` 收编七八遍，既拖慢全量跑，又让重复的异步错误被计成 unhandled
 * 而判整轮失败。
 *
 * 别名：project 级配置不继承根 `vitest.config.ts` 的 `resolve.alias`，而壳层用例
 * 普遍 import `@/…`，因此这里必须重复声明一次。
 *
 * 并发与超时：worktree 插件会创建真实 git 仓库（clone/checkout/discard），全量并行时
 * 与其他文件的 git 操作竞争系统资源，偶发 5s 超时 flake；限制 maxWorkers 后单独复跑稳定通过。
 *
 * E2E 用例（`test/e2e/desktop` 与 `test/e2e/plugins` 下的 `.e2e.ts`）由
 * `vitest.desktop.config.ts` / `vitest.plugin.config.ts` 负责，本 project 不收。
 */
export default defineProject({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    name: 'unit',
    include: [
      'packages/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}',
      'test/**/*.test.ts',
      'src/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      'test/archive/**',
      'archive/**',
      // 渲染官方 UI primitives 的 ssh-ui 组件套件需要包内 vitest.config 的
      // CSS 内联与 react 单副本别名（pnpm 下 primitives 嵌套 react@18），
      // 本 project 无此处理会挂载失败；这些套件由
      // `pnpm --filter dsh-tauri-ssh-ui test` 全量执行。
      'packages/dsh-tauri-ssh-ui/src/client/components/**',
      'packages/dsh-tauri-ssh-ui/src/client/index.test.ts',
    ],
    // 壳层模块在导入期就访问 Tauri API，node 下需要最小运行时垫片，见该文件说明。
    setupFiles: ['./test/setup/tauri-runtime.ts'],
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
