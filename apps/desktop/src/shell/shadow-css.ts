const THEMES = ['light', 'dark'] as const

/**
 * 把壳层样式表重写为 Shadow DOM 作用域。
 *
 * 壳层调色板以 `:root` / `html[data-theme=…]` 为作用域，进入 Shadow root 后匹配
 * 不到任何节点，变量会失效（背景与文字回落成透明/黑色）。
 */
export function rewriteForShadowRoot(css: string): string {
  let out = css.replaceAll(':root,:host', ':host')
  for (const theme of THEMES) {
    out = out
      .replaceAll(`html[data-theme="${theme}"]`, `:host([data-theme="${theme}"])`)
      .replaceAll(`html[data-theme=${theme}]`, `:host([data-theme=${theme}])`)
  }
  return out.replaceAll(':root', ':host')
}
