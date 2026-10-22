// @vitest-environment jsdom
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLifecycleController } from '../../../../dsh-tauri/src/client/controller'
import { registerMobileKeyboard } from './keyboard'

const device = vi.hoisted(() => ({ mobile: true }))
vi.mock('dsh-tauri/client', () => ({
  detectMobileDevice: () => device.mobile,
  defineRegister: (setup: (...args: unknown[]) => void) => setup,
}))

let controller: ReturnType<typeof createLifecycleController>
let editor: HTMLElement
let viewport: FakeViewport
let scrollBy: Mock<typeof window.scrollBy>
const nativeScrollBy = window.scrollBy
const labels: Record<string, string> = { 'input.send': '发送消息', 'input.send.queue': '排队发送', 'input.send.steer': '插话发送' }

class FakeViewport extends EventTarget {
  width = window.innerWidth
  height = window.innerHeight
  offsetTop = 0
  scale = 1
}

function touch(type: string, x: number, y: number, target: Element = document.querySelector('[data-conversation-scroll]')!) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', { value: [{ identifier: 1, clientX: x, clientY: y }] })
  target.dispatchEvent(event)
  return event
}

beforeEach(() => {
  device.mobile = true
  document.body.innerHTML = '<div data-conversation-scroll><p>Message</p><div data-composer-seat><textarea></textarea><button aria-label="发送消息"><svg></svg></button></div></div><input id="setting">'
  editor = document.querySelector('textarea')!
  editor.focus()
  viewport = new FakeViewport()
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: window.innerWidth })
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: window.innerHeight })
  scrollBy = vi.fn<typeof window.scrollBy>()
  Object.defineProperty(window, 'scrollBy', { configurable: true, writable: true, value: scrollBy })
  controller = createLifecycleController()
  const register = registerMobileKeyboard as unknown as (controller: unknown, ctx: unknown) => void
  register(controller, { locale: { bind: () => (key: string) => labels[key] ?? key } })
})

afterEach(() => {
  controller.dispose()
  Reflect.deleteProperty(window, 'visualViewport')
  for (const key of ['clientWidth', 'clientHeight', 'scrollHeight'])
    Reflect.deleteProperty(document.documentElement, key)
  Object.defineProperty(window, 'scrollBy', { configurable: true, writable: true, value: nativeScrollBy })
  document.documentElement.removeAttribute('data-dsh-mobile-sidebar')
  document.documentElement.removeAttribute('style')
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('mobile composer keyboard dismissal', () => {
  it.each(['发送消息', '排队发送', '插话发送'])('blurs the editor after the %s click handler without preventing submission', (label) => {
    const button = document.querySelector('button')!
    button.setAttribute('aria-label', label)
    const submit = vi.fn(() => expect(document.activeElement).toBe(editor))
    button.addEventListener('click', submit)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    button.querySelector('svg')!.dispatchEvent(event)
    expect(submit).toHaveBeenCalledOnce()
    expect(document.activeElement).not.toBe(editor)
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves disabled sends, stop actions and desktop input focused', () => {
    const button = document.querySelector('button')!
    button.disabled = true
    button.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.activeElement).toBe(editor)
    button.disabled = false
    button.setAttribute('aria-label', '停止')
    button.click()
    expect(document.activeElement).toBe(editor)
    button.setAttribute('aria-label', '发送消息')
    device.mobile = false
    button.click()
    expect(document.activeElement).toBe(editor)
  })

  it('dismisses on a vertical transcript swipe without consuming native scroll', () => {
    touch('touchstart', 100, 100)
    touch('touchmove', 101, 106)
    expect(document.activeElement).toBe(editor)
    expect(touch('touchmove', 102, 130).defaultPrevented).toBe(false)
    expect(document.activeElement).not.toBe(editor)
  })

  it('preserves focus for taps, horizontal gestures, programmatic scrolling and composer gestures', () => {
    touch('touchstart', 100, 100)
    touch('touchmove', 130, 102)
    touch('touchend', 130, 102)
    document.querySelector('[data-conversation-scroll]')!.dispatchEvent(new Event('scroll'))
    touch('touchstart', 100, 100, editor)
    touch('touchmove', 100, 140, editor)
    expect(document.activeElement).toBe(editor)
  })

  it('does not dismiss unrelated settings inputs or retain listeners after unload', () => {
    const setting = document.querySelector<HTMLInputElement>('#setting')!
    setting.focus()
    touch('touchstart', 100, 100)
    touch('touchmove', 100, 130)
    expect(document.activeElement).toBe(setting)
    editor.focus()
    controller.dispose()
    document.querySelector<HTMLButtonElement>('button')!.click()
    touch('touchstart', 100, 100)
    touch('touchmove', 100, 130)
    expect(document.activeElement).toBe(editor)
  })
})

describe('mobile keyboard viewport fit', () => {
  const reserved = () => document.documentElement.style.getPropertyValue('--dsh-mobile-viewport-height')

  it('reserves the visible height while a text field is focused and releases it afterwards', () => {
    viewport.height = 420
    viewport.dispatchEvent(new Event('resize'))
    expect(reserved()).toBe('420px')
    viewport.height = window.innerHeight
    editor.blur()
    viewport.dispatchEvent(new Event('resize'))
    expect(reserved()).toBe('')
  })

  it('ignores a shrunken viewport without a focused text field', () => {
    editor.blur()
    viewport.height = 420
    viewport.dispatchEvent(new Event('resize'))
    expect(reserved()).toBe('')
  })

  it('follows the keyboard height the iOS app reports', () => {
    const report = (height: number) => window.dispatchEvent(new CustomEvent('dsh-mobile-keyboard', { detail: { height } }))
    report(300)
    expect(reserved()).toBe(`${document.documentElement.clientHeight - 300}px`)
    report(0)
    expect(reserved()).toBe('')
  })

  it('keeps fitting when Safari zooms the page out without any pinch zoom', () => {
    viewport.scale = 0.85
    viewport.height = 322.3
    viewport.dispatchEvent(new Event('resize'))
    expect(reserved()).toBe('322px')
  })

  it('leaves a pinch-zoomed page to the browser', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    viewport.scale = 1.6
    viewport.width = window.innerWidth / 1.6
    viewport.height = 300
    viewport.offsetTop = 200
    viewport.dispatchEvent(new Event('resize'))
    expect(reserved()).toBe('')
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('measures the keyboard against the layout height while iOS shrinks innerHeight during its pan', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(322)
    viewport.height = 322.3
    viewport.dispatchEvent(new Event('resize'))
    expect(reserved()).toBe('322px')
    window.dispatchEvent(new CustomEvent('dsh-mobile-keyboard', { detail: { height: 300 } }))
    expect(reserved()).toBe(`${document.documentElement.clientHeight - 300}px`)
  })

  it('pulls a composer pan back to the top once the page fits, but leaves other fields to iOS', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    viewport.height = 322.3
    viewport.offsetTop = 503.5
    viewport.dispatchEvent(new Event('resize'))
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0)
    viewport.offsetTop = 0
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(120)
    viewport.dispatchEvent(new Event('scroll'))
    expect(scrollTo).toHaveBeenCalledTimes(2)
    document.querySelector<HTMLInputElement>('#setting')!.focus()
    viewport.dispatchEvent(new Event('scroll'))
    expect(scrollTo).toHaveBeenCalledTimes(2)
  })

  it('drops the reservation and viewport listeners when the plugin unloads', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    window.dispatchEvent(new CustomEvent('dsh-mobile-keyboard', { detail: { height: 300 } }))
    controller.dispose()
    expect(reserved()).toBe('')
    viewport.height = 322.3
    viewport.offsetTop = 503.5
    viewport.dispatchEvent(new Event('scroll'))
    expect(reserved()).toBe('')
    expect(scrollTo).not.toHaveBeenCalled()
  })
})

describe('composer caret reveal', () => {
  it('drops the window scroll Lexical makes after a JS edit while the page cannot scroll', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(322)
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: document.documentElement.clientHeight + 1 })
    window.scrollBy(0, -294.5)
    expect(scrollBy).not.toHaveBeenCalled()
    document.documentElement.setAttribute('data-dsh-mobile-sidebar', '')
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: document.documentElement.clientHeight + 900 })
    window.scrollBy({ top: -294.5 })
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('still scrolls pages that can scroll and other fields, and restores the native method on unload', () => {
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: document.documentElement.clientHeight + 2 })
    window.scrollBy(0, 48)
    expect(scrollBy).toHaveBeenLastCalledWith(0, 48)
    expect(scrollBy.mock.contexts.at(-1)).toBe(window)
    Reflect.deleteProperty(document.documentElement, 'scrollHeight')
    document.querySelector<HTMLInputElement>('#setting')!.focus()
    window.scrollBy(0, 24)
    expect(scrollBy).toHaveBeenLastCalledWith(0, 24)
    editor.focus()
    controller.dispose()
    expect(window.scrollBy).toBe(scrollBy)
  })
})
