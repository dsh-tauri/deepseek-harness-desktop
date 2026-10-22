import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister, detectMobileDevice } from 'dsh-tauri/client'

const COMPOSER = '[data-composer-seat], [data-slot="conversation.composer.bar"]'
const SCROLL = '[data-conversation-scroll], [data-slot="conversation.view"]'
const EDITABLE = 'textarea, input, [contenteditable="true"]'
const VIEWPORT_HEIGHT = '--dsh-mobile-viewport-height'
const NATIVE_KEYBOARD = 'dsh-mobile-keyboard'

export const registerMobileKeyboard = defineRegister<ClientContext>((controller, ctx) => {
  const t = ctx.locale.bind('conversation')
  const root = document.documentElement
  const viewport = window.visualViewport
  let touch: { id: number, x: number, y: number } | undefined
  let nativeHeight = 0
  let fitted = 0

  function composerEditor() {
    const editor = document.activeElement
    return editor instanceof HTMLElement && editor.matches(EDITABLE) && editor.closest(COMPOSER) ? editor : null
  }

  function dismissKeyboard() {
    if (detectMobileDevice())
      composerEditor()?.blur()
  }

  // iOS shrinks innerHeight to the part of the page below its keyboard pan, and Safari's page zoom reports a
  // visualViewport scale other than 1 without any pinch zoom, so the keyboard is measured against the layout viewport.
  function shrinkHeight() {
    if (nativeHeight > 0)
      return Math.max(0, root.clientHeight - nativeHeight)
    const editor = document.activeElement
    if (!(editor instanceof HTMLElement) || !editor.matches(EDITABLE) || !viewport || Math.abs(viewport.width - root.clientWidth) >= 1)
      return 0
    return root.clientHeight - viewport.height >= 1 ? Math.floor(viewport.height) : 0
  }

  // keep:effect The keyboard overlays the WebView instead of shrinking it, so the page itself has to reserve the covered height or the composer stays behind it;
  // once the page fits, the pan iOS used to reveal the composer would only show the empty space below it.
  function fitKeyboard() {
    const height = shrinkHeight()
    if (height !== fitted) {
      fitted = height
      if (height > 0)
        root.style.setProperty(VIEWPORT_HEIGHT, `${height}px`)
      else
        root.style.removeProperty(VIEWPORT_HEIGHT)
    }
    if (height > 0 && composerEditor() && ((viewport?.offsetTop ?? 0) >= 1 || window.scrollY >= 1))
      window.scrollTo(0, 0)
  }

  const scrollBy = window.scrollBy
  function keepComposerInView(this: Window, ...args: unknown[]) {
    if (!composerEditor() || (!root.hasAttribute('data-dsh-mobile-sidebar') && root.scrollHeight - root.clientHeight > 1))
      Reflect.apply(scrollBy, this, args)
  }
  // keep:effect iOS reports caret rects relative to the keyboard-panned viewport while Lexical adds visualViewport.offsetTop on top,
  // so its caret reveal after a JS edit scrolls the composer behind the keyboard; a page that cannot scroll never needs that scroll.
  window.scrollBy = keepComposerInView
  controller.add(() => {
    if (window.scrollBy === keepComposerInView)
      window.scrollBy = scrollBy
  })

  function onNativeKeyboard(event: Event) {
    const detail = (event as CustomEvent<{ height?: number }>).detail
    nativeHeight = Math.max(0, Math.round(detail?.height ?? 0))
    fitKeyboard()
  }

  window.addEventListener(NATIVE_KEYBOARD, onNativeKeyboard)
  viewport?.addEventListener('resize', fitKeyboard)
  viewport?.addEventListener('scroll', fitKeyboard)
  controller.add(() => {
    window.removeEventListener(NATIVE_KEYBOARD, onNativeKeyboard)
    viewport?.removeEventListener('resize', fitKeyboard)
    viewport?.removeEventListener('scroll', fitKeyboard)
    root.style.removeProperty(VIEWPORT_HEIGHT)
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
})
