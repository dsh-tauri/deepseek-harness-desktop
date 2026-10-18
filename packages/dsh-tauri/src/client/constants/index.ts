export { PLUGIN_ID } from '../../shared/constants'

/**
 * 触摸判据。`(hover: none)` 在部分 Android WebView（vivo V2353A，Android 14 /
 * Chrome 116）的 360px 视口被误报为 hover，改用语义更稳的 `(pointer: coarse)`：
 * 主指针是否为触摸，与 hover 能力无关。`(any-hover: none)` 保留，外接鼠标时
 * 为 false，用于区分「纯触屏」与「触屏 + 鼠标」。
 */
export const MOBILE_POINTER_QUERIES = ['(pointer: coarse)', '(any-pointer: coarse)', '(any-hover: none)'] as const

/**
 * issue #1128：官方布局在 1024px 以上走桌面，触屏笔记本同样命中指针查询；
 * 移动布局必须叠加同一门槛，否则桌面布局会被移动表的 `!important` 隐藏规则掏空。
 */
export const MOBILE_BREAKPOINT = 1024

export const MOBILE_MEDIA_QUERIES = [
  ...MOBILE_POINTER_QUERIES,
  `(max-width: ${MOBILE_BREAKPOINT - 1}px)`,
] as const

/**
 * 官方「新建会话」按钮：适配层的 DOM 退级目标，同时是侧边栏 UI 微调的居中目标。
 *
 * 与官方 aria-label 逐字一致（中英双语各一条）；绝不用生成的 CSS module 哈希。
 */
export const NEW_SESSION_SELECTOR = 'button[aria-label="新建会话"],button[aria-label="New session"]'
