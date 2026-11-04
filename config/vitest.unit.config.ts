import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url))

const alias = {
  '@': source('../apps/desktop/src'),
  'dsh-tauri/client': source('../packages/builtin-plugin-tauri/src/client/index.ts'),
  'dsh-tauri-ui/client': source('../packages/builtin-plugin-ui/src/client/index.ts'),
  'dsh-tauri': source('../packages/builtin-plugin-tauri/src/index.ts'),
  'dsh-tauri-ui': source('../packages/builtin-plugin-ui/src/index.ts'),
}

export default defineProject({
  root: source('..'),
  define: { __REMOTE_DSH_MINIMUM__: JSON.stringify('0.2.1-rc.1') },
  resolve: { alias },
  test: {
    name: 'unit',
    environment: 'node',
    setupFiles: [source('./vitest.unit.setup.ts')],
    server: { deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives', 'dsh-pet-component'] } },
    include: ['apps/desktop/src/**/*.test.{ts,tsx}', 'packages/**/src/**/*.test.ts', 'tests/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/target/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
