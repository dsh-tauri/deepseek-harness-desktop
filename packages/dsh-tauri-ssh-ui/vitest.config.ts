import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * The section components render the official UI primitives, whose package
 * ships real `.module.css` sidecars and (under pnpm) a nested react@18 —
 * while this package develops against the workspace react. In the deployed
 * ModuleLoader there is exactly one platform react for both; these test-time
 * settings recreate that: the primitives package is inlined so Vite can
 * process its CSS imports, and every react specifier is pinned to the
 * workspace copy so jsdom mounts one renderer, not two.
 */
const reactRoot = fileURLToPath(new URL('../../node_modules/react', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react$/, replacement: reactRoot },
      { find: /^react\/jsx-runtime$/, replacement: `${reactRoot}/jsx-runtime.js` },
      { find: /^react\/jsx-dev-runtime$/, replacement: `${reactRoot}/jsx-dev-runtime.js` },
    ],
  },
  test: {
    css: true,
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-client-ui-primitives/],
      },
    },
  },
})
