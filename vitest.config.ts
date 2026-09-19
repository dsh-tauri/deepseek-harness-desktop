import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * 根 Vitest 配置：只放「跨 project 的全局项」与 project 清单。
 *
 * Vitest 不把根配置本身当作 project（除非显式列出），因此这里不再写任何 include：
 * 用例归属由 `vitest.unit.config.ts`（单元）与 `vitest.e2e.config.ts`（E2E）各自声明。
 *
 * 仓库根还 vendored 了 dsh 核心源码（`source/` 与 `archive/`），其测试依赖 dsh 核心的
 * `@/` paths 解析（在插件 workspace 的 vitest 下不可用），故两个 project 都不纳入。
 */
export default defineConfig({
  // 与 vite.config.ts 保持一致：src 内部统一用 `@/` 别名。
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    projects: [
      './vitest.unit.config.ts',
      './vitest.e2e.config.ts',
    ],
  },
})
