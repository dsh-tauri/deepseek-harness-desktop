const OVERLAY_SELECTORS = '[class^="_mask_"], [class*=" _mask_"]'

const FRAME_SELECTOR = 'div[class$="_frame"]'

const COMPONENT_REGION_SELECTOR = '[data-slot]'

export const STYLE_INPUT_SELECTOR = `${OVERLAY_SELECTORS}, ${FRAME_SELECTOR}, [data-slot="sidebar"], [data-slot="sidebar"] > div, style, link[rel~="stylesheet" i]`

/** 全透明底色的判定：`transparent` 与 `rgba(…, 0)`（含现代浏览器的空格/斜杠分隔）。 */
function isTransparent(color: string): boolean {
  const value = color.trim().toLowerCase()
  if (value === '' || value === 'transparent')
    return true
  const match = /^rgba?\(([^)]+)\)$/.exec(value)
  if (match === null)
    return false
  const channels = match[1].split(/[\s,/]+/).filter(Boolean)
  return channels.length >= 4 && Number.parseFloat(channels[3]) === 0
}

function isInsideFixed(element: Element): boolean {
  const parent = element.parentElement
  return parent !== null && getComputedStyle(parent).position === 'fixed'
}

/**
 * 底色实际落在的那一层。
 *
 * 0.1.7-rc.2 起官方把 Modal 蒙版的底色从元素搬到 `::after`（同时在那里做入场动画），
 * 只读元素自身会拿到全透明的 background——这正是「navbar 同步蒙版失效」的成因。
 */
function paintedLayer(own: CSSStyleDeclaration, after: CSSStyleDeclaration): CSSStyleDeclaration {
  return isTransparent(own.backgroundColor) ? after : own
}

/** 同一页面可能并存多个 `_mask_`（Modal、图片预览、PDF 预览）：优先父子层级与底色都成立的弹层蒙版。 */
function overlayElement(): Element | null {
  const candidates = [...document.querySelectorAll(OVERLAY_SELECTORS)]
  const fixed = candidates.filter(isInsideFixed)
  const pool = fixed.length > 0 ? fixed : candidates
  return pool.find((element) => {
    const own = getComputedStyle(element)
    return !isTransparent(own.backgroundColor) || !isTransparent(getComputedStyle(element, '::after').backgroundColor)
  }) ?? pool[0] ?? null
}

function transitionDuration(animationDuration: string): string {
  const first = animationDuration.split(',')[0]?.trim() ?? ''
  return first === '' ? '0s' : first
}

export function getSidebarStyle() {
  const sidebar = document.querySelector('[data-slot="sidebar"] > div')
  if (!sidebar)
    return null
  const computedStyle = getComputedStyle(sidebar)
  return {
    background: computedStyle.background,
  }
}

/**
 * 弹层蒙版的镜像样式。
 *
 * 入场动效按官方 `modalEnter` 的时长/缓动镜像成 `background`、`backdrop-filter` 过渡：
 * 壳层在自己的文档里，拿不到包内 CSS 的 keyframes 名，过渡是等价且不跨文档的实现
 * （进场淡入、出场瞬时，与官方一致）；无动画的代次（≤0.1.7-alpha.1）时长解析为 `0s`。
 */
export function getOverlayMarkedStyle() {
  const overlay = overlayElement()
  if (!overlay)
    return null
  const own = getComputedStyle(overlay)
  const painted = paintedLayer(own, getComputedStyle(overlay, '::after'))

  return {
    inset: own.inset,
    background: painted.background,
    backdropFilter: own.backdropFilter,
    bottom: '-1px',
    transitionProperty: 'background, backdrop-filter',
    transitionDuration: transitionDuration(painted.animationDuration),
    transitionTimingFunction: painted.animationTimingFunction || 'ease',
  }
}

export function getFrameStyle() {
  const frames = [...document.querySelectorAll(FRAME_SELECTOR)]
  const frame = frames.find(candidate => candidate.closest(COMPONENT_REGION_SELECTOR) === null)
  if (!frame)
    return null
  const computedStyle = getComputedStyle(frame)
  return {
    background: computedStyle.background,
  }
}
