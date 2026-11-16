const OVERLAY_SELECTORS = '[class^="_mask_"], [class*=" _mask_"]'

const FRAME_SELECTOR = 'div[class$="_frame"]'

const COMPONENT_REGION_SELECTOR = '[data-slot]'

export const STYLE_INPUT_SELECTOR = `${OVERLAY_SELECTORS}, ${FRAME_SELECTOR}, [data-slot="sidebar"], [data-slot="sidebar"] > div, style, link[rel~="stylesheet" i]`

function isTransparent(color: string): boolean {
  const value = color.trim().toLowerCase()
  if (value === '' || value === 'transparent')
    return true
  const match = /^rgba?\(([^)]+)\)$/.exec(value)
  if (match === null)
    return false
  const channels = match[1]!.split(/[\s,/]+/).filter(Boolean)
  const alpha = channels[3]
  return channels.length >= 4 && alpha !== undefined && Number.parseFloat(alpha) === 0
}

function isInsideFixed(element: Element): boolean {
  const parent = element.parentElement
  return parent !== null && getComputedStyle(parent).position === 'fixed'
}

function paintedLayer(own: CSSStyleDeclaration, after: CSSStyleDeclaration): CSSStyleDeclaration {
  return isTransparent(own.backgroundColor) ? after : own
}

function isVisible(element: Element): boolean {
  const { visibility } = getComputedStyle(element)
  if (visibility === 'hidden' || visibility === 'collapse')
    return false
  for (let ancestor: Element | null = element; ancestor !== null; ancestor = ancestor.parentElement) {
    if (ancestor.hasAttribute('hidden') || getComputedStyle(ancestor).display === 'none')
      return false
  }
  return true
}

function overlayElement(): Element | null {
  const candidates = [...document.querySelectorAll(OVERLAY_SELECTORS)].filter(isVisible)
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
