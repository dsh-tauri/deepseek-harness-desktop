import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// `expo/tsconfig.base` 的 lib 含 DOM，`new URL()` 会得到 DOM 的 URL 类型而无法传给 node 的 `fileURLToPath`；
// 这里改用 `path.join` + `import.meta.url` 字符串，避免 DOM/node 的 URL 类型冲突。
const nativeRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src-native')

export default defineConfig({
  resolve: {
    alias: {
      '@': nativeRoot,
    },
  },
  test: {
    environment: 'node',
    include: ['src-native/**/*.test.{ts,tsx}'],
    testTimeout: 10000,
  },
})
