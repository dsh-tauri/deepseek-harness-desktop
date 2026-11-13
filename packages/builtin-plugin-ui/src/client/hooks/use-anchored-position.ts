import type { CSSProperties, RefObject } from 'react'
import { useLayoutEffect, useState } from 'react'

export interface AnchoredPositionOptions {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  panelRef: RefObject<HTMLElement | null>
  side?: 'top' | 'bottom' | 'right'
  align?: 'start' | 'end'
  gap: number
  margin: number
  frameClearance?: boolean
  getAnchorRect?: () => DOMRect | null
  layoutKey?: string | number
  minWidthFromAnchor?: boolean
}

interface PanelRect {
  x: number
  y: number
  width: number
  height: number
}

const FRAME_TOP_CLEARANCE = '--dsh-frame-top-clearance'

const MAX_WIDTH_PROPERTY = '--dsh-anchored-max-width'

const MAX_HEIGHT_PROPERTY = '--dsh-anchored-max-height'

export function useAnchoredPosition(options: AnchoredPositionOptions): CSSProperties | null {
  const {
    open,
    anchorRef,
    panelRef,
    side = 'bottom',
    align = 'start',
    gap,
    margin,
    getAnchorRect,
    minWidthFromAnchor = false,
    frameClearance = true,
  } = options
  const [position, setPosition] = useState<CSSProperties | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      // eslint-disable-next-line react/set-state-in-effect -- 关闭即清空定位，下一帧没有任何可测量的锚点
      setPosition(null)
      return
    }
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (anchor === null || panel === null)
      return
    const win = anchor.ownerDocument.defaultView
    if (win === null)
      return
    const viewport = win.visualViewport
    const visualOrigin = typeof win.CSS !== 'undefined' && win.CSS.supports('-webkit-backdrop-filter', 'none')
    const previous = [
      MAX_WIDTH_PROPERTY,
      MAX_HEIGHT_PROPERTY,
      ...(minWidthFromAnchor ? ['min-width'] : []),
    ].map(name => [name, panel.style.getPropertyValue(name), panel.style.getPropertyPriority(name)] as const)
    let active = true
    let lastRect: PanelRect | null = null

    const readRect = (): DOMRect | null => getAnchorRect === undefined ? anchor.getBoundingClientRect() : getAnchorRect()

    const place = (rect: DOMRect | null): void => {
      lastRect = rect === null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      let next: CSSProperties | null = null
      if (rect !== null) {
        const x = viewport?.offsetLeft ?? 0
        const y = viewport?.offsetTop ?? 0
        const width = viewport?.width ?? (anchor.ownerDocument.documentElement.clientWidth || win.innerWidth)
        const height = viewport?.height ?? (anchor.ownerDocument.documentElement.clientHeight || win.innerHeight)
        const topMargin = frameClearance ? overlayTopMargin(margin, rect, gap) : margin
        const maxWidth = Math.max(0, width - margin * 2)
        panel.style.setProperty(MAX_WIDTH_PROPERTY, `${maxWidth}px`)
        panel.style.setProperty(MAX_HEIGHT_PROPERTY, `${Math.max(0, height - topMargin - margin)}px`)
        if (minWidthFromAnchor)
          panel.style.minWidth = `${Math.min(rect.width, maxWidth)}px`
        const panelWidth = panel.offsetWidth
        const panelHeight = panel.offsetHeight
        const offsetX = visualOrigin ? x : 0
        const offsetY = visualOrigin ? y : 0
        const left = offsetX + (side === 'right' ? rect.right + gap : align === 'end' ? rect.right - panelWidth : rect.left)
        const top = offsetY + (side === 'right' ? rect.top : side === 'top' ? rect.top - gap - panelHeight : rect.bottom + gap)
        next = {
          left: Math.max(x + margin, Math.min(left, x + width - margin - panelWidth)),
          top: Math.max(y + topMargin, Math.min(top, y + height - margin - panelHeight)),
        }
      }
      setPosition(current => current?.left === next?.left && current?.top === next?.top ? current : next)
    }

    const update = (): void => {
      if (!active)
        return
      place(readRect())
    }

    update()
    win.addEventListener('scroll', update, true)
    win.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    viewport?.addEventListener('resize', update)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(anchor)
    observer?.observe(panel)

    let frame = 0
    const track = (): void => {
      if (!active)
        return
      const rect = readRect()
      if (rect?.x !== lastRect?.x || rect?.y !== lastRect?.y || rect?.width !== lastRect?.width || rect?.height !== lastRect?.height)
        place(rect)
      frame = win.requestAnimationFrame(track)
    }
    frame = win.requestAnimationFrame(track)

    return () => {
      active = false
      win.cancelAnimationFrame(frame)
      observer?.disconnect()
      win.removeEventListener('scroll', update, true)
      win.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      viewport?.removeEventListener('resize', update)
      for (const [name, value, priority] of previous)
        panel.style.setProperty(name, value, priority)
    }
  }, [open, anchorRef, panelRef, side, align, gap, margin, getAnchorRect, minWidthFromAnchor, frameClearance, options.layoutKey])

  return position
}

function overlayTopMargin(min: number, anchor: DOMRect | undefined, gap = 0): number {
  const root = document.documentElement
  const clearance = Number.parseFloat(getComputedStyle(root).getPropertyValue(FRAME_TOP_CLEARANCE))
  if (Number.isNaN(clearance))
    return min
  const cap = anchor !== undefined && anchor.top >= 0 ? anchor.bottom + gap : Number.POSITIVE_INFINITY
  return Math.max(min, Math.min((root.hasAttribute('data-fullscreen') ? 0 : clearance) + 20, cap))
}
