import type { Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

/**
 * 壳层独立构建：产出单份自包含 ESM（`shell.mjs`）。
 *
 * 用 ESM 而非 IIFE：壳层依赖（`tauri-runtime-electron/api`）含顶层 await，IIFE 不支持。
 * 注入侧以 Blob URL 动态 `import()`，因此不需要打包成自执行脚本。
 *
 * 样式直接内联进 `shell.mjs`：注入脚本只需要传一份 JS，不必再传 CSS。做法是让 Rollup
 * 照常产出 css asset，在这里把 `:root` 改写为 `:host`、把 `html[data-theme=x]` 改写为
 * `:host([data-theme=x])`，再把结果替换进 `shell.tsx` 的 `SHELL_CSS` 占位符并删除该
 * asset。相比 `?inline`，这条路能精确区分「样式表」与「运行时拼出来的样式字符串」。
 */
function shadowScopedCss(): Plugin {
  const themes = ['light', 'dark']
  const placeholder = '__DSH_SHELL_CSS_PLACEHOLDER__'
  return {
    name: 'dsh-shell-shadow-css',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const cssAssets = Object.values(bundle).filter(
          chunk => chunk.type === 'asset' && chunk.fileName.endsWith('.css'),
        )
        let css = ''
        for (const asset of cssAssets) {
          css += String(asset.source)
          delete bundle[asset.fileName]
        }
        css = css.replaceAll(':root,:host', ':host')
        for (const theme of themes) {
          css = css
            .replaceAll(`html[data-theme="${theme}"]`, `:host([data-theme="${theme}"])`)
            .replaceAll(`html[data-theme=${theme}]`, `:host([data-theme=${theme}])`)
        }
        css = css.replaceAll(':root', ':host')
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== 'chunk' || !chunk.code.includes(placeholder))
            continue
          // 占位符本身是一个字符串字面量（`'<placeholder>'`），必须连同引号一起替换成
          // `JSON.stringify(css)`；只换内部文本会得到 `'"<css>"'`，CSS 里的引号与换行
          // 会让整个模块语法失效（`bootstrap failed SyntaxError`）。压缩器可能把单引号
          // 换成双引号，两种都要命中。
          chunk.code = chunk.code.replace(
            new RegExp(`(['"])${placeholder}\\1`, 'g'),
            () => JSON.stringify(css),
          )
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
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('"use client"'))
          return
        warn(warning)
      },
      output: { inlineDynamicImports: true },
    },
    lib: {
      entry: fileURLToPath(new URL('./src/shell.tsx', import.meta.url)),
      formats: ['es'],
      fileName: () => 'shell.mjs',
      cssFileName: 'shell',
    },
  },
})
