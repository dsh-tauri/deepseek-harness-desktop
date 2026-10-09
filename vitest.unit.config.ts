import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'
import { SHARED_ALIAS } from './tooling.config'

export default defineProject({
  resolve: {
    alias: {
      ...SHARED_ALIAS,
      'dsh-tauri/client': fileURLToPath(new URL('./packages/dsh-tauri/src/client/index.ts', import.meta.url)),
      'dsh-tauri': fileURLToPath(new URL('./packages/dsh-tauri/src/index.ts', import.meta.url)),
      'dsh-tauri-ui/client': fileURLToPath(new URL('./packages/dsh-tauri-ui/src/client/index.ts', import.meta.url)),
      'dsh-tauri-ui': fileURLToPath(new URL('./packages/dsh-tauri-ui/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'unit',
    include: [
      'packages/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}',
      'test/**/*.test.ts',
      'src/**/*.test.{ts,tsx}',
    ],
    exclude: [
      '**/node_modules/**',
      'test/archive/**',
      'archive/**',
    ],
    // 壳层模块在导入期就访问 Tauri API，node 下需要最小运行时垫片，见该文件说明。
    setupFiles: ['./test/setup/tauri-runtime.ts'],
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
