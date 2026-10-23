export { PLUGIN_ID } from '../../shared/constants'

/**
 * 触摸判据。只看指针能力，不含 hover 类查询。
 *
 * vivo V2353A（Android 14 / Chrome 116）在 360px 视口把 `(hover: none)` 与
 * `(any-hover: none)` 一起报成 false，而 `(pointer: coarse)`、`(any-pointer: coarse)`
 * 均为 true。hover 类查询一旦进入 `every` 合取，一条误报就让整块移动布局失效——
 * CSS 头由本常量拼出，样式与脚本一起退回桌面。
 *
 * 代价：主指针为触摸的窄屏设备即使外接鼠标也判为移动端。
 */
export const MOBILE_POINTER_QUERIES = ['(pointer: coarse)', '(any-pointer: coarse)'] as const

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
