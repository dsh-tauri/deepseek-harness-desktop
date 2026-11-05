import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

/**
 * 壳层样式单独构建：把 `src/styles/main.css`（Tailwind + HeroUI）编译成一份 CSS，
 * 供 Shadow DOM 注入。产物随后由 `scripts/build-shell-css.ts` 重写为 `:host` 作用域
 * 并固化给 Rust `include_str!`。入口必须是 JS/TS，Vite 不接受 CSS 直接作为 lib 入口。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [tailwindcss()],
  build: {
    outDir: 'dist-shell',
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL('./src/shell/shell-style.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'shell-style.js',
      cssFileName: 'shell',
    },
    minify: false,
  },
})
