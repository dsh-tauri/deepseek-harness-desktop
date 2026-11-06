/** 壳层窗口圆角边框的当前形态。 */
export type FrameMode = '' | 'border' | 'flat'

export const IS_MACOS = typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh')

/** 壳层导航栏高度，DSH 文档需要为它让出顶部空间。 */
export const SHELL_NAVBAR_HEIGHT = 44

/** 当前进程是否跑在原生窗口里（非浏览器预览）。 */
export function hasNativeWindow(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 建窗时由 Rust 注入，声明该窗口使用圆角自绘边框。 */
export function isFramedWindow(): boolean {
  return typeof window !== 'undefined' && (window as Window & { __DSH_FRAME__?: boolean }).__DSH_FRAME__ === true
}

/**
 * 计算边框形态：非自绘边框窗口不启用；最大化或全屏时压平，否则留出圆角边。
 */
export function frameMode(maximized: boolean, fullscreen = false): FrameMode {
  if (!isFramedWindow())
    return ''
  return fullscreen || maximized ? 'flat' : 'border'
}

/** 把边框形态写到文档根节点，供样式表命中。 */
export function applyFrameMode(maximized: boolean, fullscreen = false): void {
  const mode = frameMode(maximized, fullscreen)
  if (mode)
    document.documentElement.dataset.dshFrame = mode
  else
    delete document.documentElement.dataset.dshFrame
}

/**
 * 让 DSH 文档为壳层导航栏让出顶部空间。
 *
 * DSH 用 `data-windows-titlebar` 声明「顶部有一条自绘标题条」，并按其高度给主框架加
 * padding-top。文档即 DSH 时顶部那条就是壳层导航栏，因此复用同一套让位逻辑。全屏时导航栏
 * 自身隐藏，标记一并撤掉。
 *
 * 同时必须把 `--dsh-frame-chrome-top` 压到 0：该变量原本表示「原生标题栏占用的区域，
 * 模态遮罩不要绘制」，DSH 的遮罩用 `inset: var(--dsh-frame-chrome-top)` 让出顶部。但在
 * 这里那 44px 是应用自己的导航栏、属于内容区，遮罩应当盖住它，否则弹窗打开时导航栏
 * 还露在外面且仍可点击。
 */
export function applyHostedTitlebar(hosted: boolean, hidden: boolean): void {
  const root = document.documentElement
  if (!hosted || hidden) {
    delete root.dataset.windowsTitlebar
    root.style.removeProperty('--dsh-windows-titlebar-height')
    root.style.removeProperty('--dsh-frame-chrome-top')
    return
  }
  root.dataset.windowsTitlebar = ''
  root.style.setProperty('--dsh-windows-titlebar-height', `${SHELL_NAVBAR_HEIGHT}px`)
  root.style.setProperty('--dsh-frame-chrome-top', '0px')
}
