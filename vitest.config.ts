import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * 根测试配置：运行内置插件（packages/**）及壳层状态机/入口契约回归测试，
 * 限制并发 worker 数与放宽超时。
 *
 * 仓库根还 vendored 了 dsh 核心源码（source/ 与 test/ 下的部分用例），其测试依赖
 * dsh 核心的 `@/` paths 解析（在插件 workspace 的 vitest 下不可用），故 exclude 出
 * 本范围；壳层自身的用例按文件显式列入 include。
 *
 * dsh-tauri-worktree 的 operation.test 会创建真实 git 仓库（clone/checkout/
 * discard），全量并行（默认 cpu-1 个 worker）时与其他文件的 git 操作竞争系统
 * 资源，偶发 5s 超时 flake；限制 maxWorkers 后单独复跑稳定通过。
 */
export default defineConfig({
  // 与 vite.config.ts 保持一致：src 内部统一用 `@/` 别名，测试入口也必须能解析。
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: [
      'packages/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}',
      'test/toast.test.ts',
      // issue #469：桌面端不得持有屏幕唤醒锁（壳层用 reause useWakeLock 释放，桌宠 <video> 会间接加锁）。
      'test/wake-lock.test.ts',
      // issue #469：收起桌宠必须是销毁窗口（隐藏窗口里的视频仍在播放并持锁）。
      'test/pet-window-lifecycle.test.ts',
      // issue #525：补丁层 YAML 语法错误的识别与信息提取（纯函数回归）。
      'test/patch-layer.test.ts',
      // issue #539：旧版 WebKit 缺全局 Iterator 导致插件加载失败，壳层兼容垫片回归。
      'test/compat-iterator.test.ts',
      // issue #596：本地核心低于内置插件基线导致启动失败，核心面板与后端共用的版本判定回归。
      'test/core-version.test.ts',
      // 离线安装包（issue #344）：构建期资源清单与 Rust 侧资产命名/版本解析保持同源。
      'test/bundle-metadata.test.ts',
      // v0.2.0：气泡托管给 dsh-pet-component，宿主侧只剩「会话快照 → pet.bubble」的映射。
      'src/pet/hooks/use-bubble-tracker.test.ts',
      // 桌宠素材响应头：GitHub 对中文动画名回 `content-disposition`，插件版 fetch 会因
      // 非 ISO-8859-1 抛错并静默不落 IndexedDB（pnpm patch 过滤该头，这里锁住契约）。
      'test/pet-asset-headers.test.ts',
    ],
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
