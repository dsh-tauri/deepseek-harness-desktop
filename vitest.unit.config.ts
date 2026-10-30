import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url))

const alias = {
  '@': source('./apps/desktop/src'),
  'dsh-tauri/client': source('./packages/builtin-plugin-tauri/src/client/index.ts'),
  'dsh-tauri-ui/client': source('./packages/builtin-plugin-ui/src/client/index.ts'),
  'dsh-tauri': source('./packages/builtin-plugin-tauri/src/index.ts'),
  'dsh-tauri-ui': source('./packages/builtin-plugin-ui/src/index.ts'),
}

const optionalPrimitiveDependency = source('./apps/desktop/tests/unit/primitives-optional-deps.ts')

const optionalPrimitiveAliases = Object.fromEntries([
  ...'simple-icons anser shiki/core shiki/engine/javascript @deepseek-ai/dsh-util-code-language'.split(' '),
  ...'typescript shellscript json python ruby go rust java c cpp csharp kotlin swift php yaml toml ini markdown mdx html css scss less sql xml lua bat powershell fish dotenv log csv diff http rst latex bibtex asciidoc r julia dart scala clojure erlang elixir haskell fsharp vb perl verilog system-verilog graphql proto hcl nix vue svelte make cmake groovy'.split(' ').map(language => `@shikijs/langs/${language}`),
].map(name => [name, optionalPrimitiveDependency]))

export default defineProject({
  define: { __REMOTE_DSH_RECOMMEND__: JSON.stringify('0.2.1-rc.4'), __REMOTE_DSH_MINIMUM__: JSON.stringify('0.1.7-rc.1') },
  resolve: { alias: { ...alias, ...optionalPrimitiveAliases } },
  test: {
    name: 'unit',
    environment: 'node',
    server: { deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives', 'dsh-pet-component'] } },
    include: ['apps/desktop/src/**/*.test.{ts,tsx}', 'packages/builtin-plugin-*/src/**/*.test.{ts,tsx}', 'apps/desktop/tests/unit/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/target/**'],
    setupFiles: ['./apps/desktop/tests/unit/tauri-runtime.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
