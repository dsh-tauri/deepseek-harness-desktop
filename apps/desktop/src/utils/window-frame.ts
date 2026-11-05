/** 壳层窗口圆角边框的当前形态。 */
export type FrameMode = '' | 'border' | 'flat'

export const IS_MACOS = typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh')

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
