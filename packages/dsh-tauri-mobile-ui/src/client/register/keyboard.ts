import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister, detectMobileDevice, MOBILE_POINTER_QUERIES } from 'dsh-tauri/client'

const COMPOSER = '[data-composer-seat], [data-slot="conversation.composer.bar"]'
const SCROLL = '[data-conversation-scroll], [data-slot="conversation.view"]'
const EDITABLE = 'textarea, input, [contenteditable="true"]'
const VIEWPORT_HEIGHT = '--dsh-mobile-viewport-height'

export const registerMobileKeyboard = defineRegister<ClientContext>((controller, ctx) => {
  const t = ctx.locale.bind('conversation')
  const root = document.documentElement
  let touch: { id: number, x: number, y: number } | undefined

  function focusedEditor() {
    const editor = document.activeElement
    return editor instanceof HTMLElement && editor.matches(EDITABLE) ? editor : null
  }

  function dismissKeyboard() {
    const editor = focusedEditor()
    if (detectMobileDevice() && editor?.closest(COMPOSER))
      editor.blur()
  }

  function fixedPage() {
    return root.hasAttribute('data-dsh-mobile-sidebar') || root.scrollHeight - window.innerHeight <= 1
  }

  const scrollBy = window.scrollBy
  function keepKeyboardPan(this: Window, ...args: unknown[]) {
    if (!fixedPage() || !focusedEditor()?.closest(COMPOSER))
      Reflect.apply(scrollBy, this, args)
  }
  // keep:effect Lexical reveals the caret after a JS delete with window.scrollBy; on a page that cannot scroll iOS turns it into dropping the keyboard pan.
  window.scrollBy = keepKeyboardPan
  controller.add(() => {
    if (window.scrollBy === keepKeyboardPan)
      window.scrollBy = scrollBy
  })

  controller.listen('click', (event) => {
    if (!(event.target instanceof Element))
      return
    const button = event.target.closest<HTMLButtonElement>('button')
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true' || !button.closest(COMPOSER))
      return
    if ([t('input.send'), t('input.send.queue'), t('input.send.steer')].includes(button.getAttribute('aria-label') ?? ''))
      dismissKeyboard()
  })
  controller.listen('touchstart', (event) => {
    touch = undefined
    if (!detectMobileDevice() || event.touches.length !== 1 || !(event.target instanceof Element) || event.target.closest(COMPOSER) || !event.target.closest(SCROLL))
      return
    const point = event.touches[0]!
    touch = { id: point.identifier, x: point.clientX, y: point.clientY }
  }, { passive: true })
  controller.listen('touchmove', (event) => {
    if (!touch || event.touches.length !== 1)
      return
    const point = event.touches[0]!
    if (point.identifier !== touch.id)
      return
    const dy = Math.abs(point.clientY - touch.y)
    if (dy > 10 && dy > Math.abs(point.clientX - touch.x)) {
      dismissKeyboard()
      touch = undefined
    }
  }, { passive: true })
  function resetTouch() {
    touch = undefined
  }
  controller.listen('touchend', resetTouch, { passive: true })
  controller.listen('touchcancel', resetTouch, { passive: true })

  const viewport = window.visualViewport
  if (!viewport || typeof window.matchMedia !== 'function')
    return
  const touchOnly = window.matchMedia(MOBILE_POINTER_QUERIES.join(' and '))
  let frame: number | undefined
  let height = 0
  const fitViewport = (): void => {
    frame = undefined
    const editor = focusedEditor()
    const active = touchOnly.matches && Math.abs(viewport.scale - 1) < 0.01
    const composing = active && editor !== null && editor.closest(COMPOSER) !== null
    const next = composing && window.innerHeight - viewport.height >= 1 ? Math.floor(viewport.height) : 0
    if (next !== height) {
      height = next
      if (next > 0)
        root.style.setProperty(VIEWPORT_HEIGHT, `${next}px`)
      else
        root.style.removeProperty(VIEWPORT_HEIGHT)
    }
    if ((composing || (active && editor === null && fixedPage())) && (viewport.offsetTop >= 1 || window.scrollY >= 1))
      window.scrollTo(0, 0)
  }
  const scheduleFit = (): void => {
    frame ??= requestAnimationFrame(fitViewport)
  }
  // keep:effect VisualViewport events have no controller event target; controller owns the listeners and the pending frame.
  viewport.addEventListener('resize', scheduleFit)
  viewport.addEventListener('scroll', scheduleFit)
  controller.add(() => {
    viewport.removeEventListener('resize', scheduleFit)
    viewport.removeEventListener('scroll', scheduleFit)
    if (frame !== undefined)
      cancelAnimationFrame(frame)
    root.style.removeProperty(VIEWPORT_HEIGHT)
  })
  controller.listen('focusin', scheduleFit)
  controller.listen('focusout', scheduleFit)
})
