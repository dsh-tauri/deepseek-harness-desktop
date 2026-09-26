import { defineConfig } from 'vitest/config'

/**
 * 包内套件入口：根 vitest.config.ts 已改为 project 清单（unit/plugin/desktop
 * 三 lane），从包目录裸跑 `vitest run` 会在错误的 CWD 下解析那份清单。本包
 * 用例全部是 node 环境的纯单测，显式声明自身配置即可独立运行
 * （`pnpm --filter dsh-tauri-ssh test`），也避免依赖根 lane 的装配前提。
 */
export default defineConfig({
  test: {
    environment: 'node',
  },
})
