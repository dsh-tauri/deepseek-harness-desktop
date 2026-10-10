import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'
import { SHARED_ALIAS } from './tooling.config'

const optionalPrimitiveDependency = fileURLToPath(new URL('./test/setup/primitives-optional-deps.ts', import.meta.url))
const optionalPrimitiveAliases = Object.fromEntries([
  ...'simple-icons anser shiki/core shiki/engine/javascript @deepseek-ai/dsh-util-code-language'.split(' '),
  ...'typescript shellscript json python ruby go rust java c cpp csharp kotlin swift php yaml toml ini markdown mdx html css scss less sql xml lua bat powershell fish dotenv log csv diff http rst latex bibtex asciidoc r julia dart scala clojure erlang elixir haskell fsharp vb perl verilog system-verilog graphql proto hcl nix vue svelte make cmake groovy'.split(' ').map(language => `@shikijs/langs/${language}`),
].map(name => [name, optionalPrimitiveDependency]))

export default defineProject({
  resolve: {
    alias: {
      ...SHARED_ALIAS,
      ...optionalPrimitiveAliases,
      'dsh-tauri/client': fileURLToPath(new URL('./packages/dsh-tauri/src/client/index.ts', import.meta.url)),
      'dsh-tauri': fileURLToPath(new URL('./packages/dsh-tauri/src/index.ts', import.meta.url)),
      'dsh-tauri-ui/client': fileURLToPath(new URL('./packages/dsh-tauri-ui/src/client/index.ts', import.meta.url)),
      'dsh-tauri-ui': fileURLToPath(new URL('./packages/dsh-tauri-ui/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'unit',
    server: {
      deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives'] },
    },
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
