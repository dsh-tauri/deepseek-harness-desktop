import type { Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

/**
 * lib 模式把壳层打成单份 IIFE + 单份 CSS：
 * - sandbox preload 只能执行经典脚本，故用 `iife` 而非 ESM；
 * - Rust 侧 `include_str!` 直接内嵌这两份产物。
 */
function shadowScopedCss(): Plugin {
  const themes = ['light', 'dark']
  return {
    name: 'dsh-shell-shadow-css',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== 'asset' || !chunk.fileName.endsWith('.css'))
            continue
          let css = String(chunk.source).replaceAll(':root,:host', ':host')
          for (const theme of themes) {
            css = css
              .replaceAll(`html[data-theme="${theme}"]`, `:host([data-theme="${theme}"])`)
              .replaceAll(`html[data-theme=${theme}]`, `:host([data-theme=${theme}])`)
          }
          chunk.source = css.replaceAll(':root', ':host')
        }
      },
    },
  }
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: false,
  plugins: [tailwindcss(), shadowScopedCss()],
  build: {
    outDir: 'dist.shell',
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL('./src/shell.ts', import.meta.url)),
      formats: ['iife'],
      name: '__DSH_SHELL__',
      fileName: () => 'shell.iife.js',
      cssFileName: 'shell',
    },
  },
})
