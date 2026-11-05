import type { Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

/**
 * 壳层独立构建：产出单份 ESM（`shell.mjs`）+ 单份 CSS（`shell.css`）。
 *
 * 用 ESM 而非 IIFE：壳层依赖（`tauri-runtime-electron/api`）含顶层 await，IIFE 不支持。
 * 注入侧以 Blob URL 动态 `import()`，因此不需要打包成自执行脚本。
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
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [tailwindcss(), shadowScopedCss()],
  // 壳层在主世界执行，那里没有 Node 的 `process`；只替换依赖里的环境判断。
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: 'dist.shell',
    emptyOutDir: true,
    // 注入侧只有一个 Blob URL，无法解析相对导入；依赖的动态 import 必须内联成一个文件。
    rollupOptions: { output: { inlineDynamicImports: true } },
    lib: {
      entry: fileURLToPath(new URL('./src/shell.tsx', import.meta.url)),
      formats: ['es'],
      fileName: () => 'shell.mjs',
      cssFileName: 'shell',
    },
  },
})
