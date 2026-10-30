import { afterEach, describe, expect, it, vi } from 'vitest'
import { emittedOf, resetTauriMock } from '../test-utils/tauri-mock'
import { zoomShortcutFeature } from './zoom-shortcut'

vi.mock('../service/tauri', async () => (await import('../test-utils/tauri-mock')).tauriMock)

const TYPE_ZOOM_SHORTCUT = 'dsh://zoom-shortcut'

interface Dom {
  keydown: (event: Record<string, unknown>) => void
  listenerCount: () => number
  captured: () => boolean
}

function stubDom(): Dom {
  const listeners = new Set<(event: unknown) => void>()
  let captured = false
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('document', {
    addEventListener: (_type: string, handler: (event: unknown) => void, options?: AddEventListenerOptions) => {
      captured = options?.capture === true
      listeners.add(handler)
    },
    removeEventListener: (_type: string, handler: (event: unknown) => void) => listeners.delete(handler),
  })
  return {
    keydown: (event) => {
      for (const handler of [...listeners])
        handler(event)
    },
    listenerCount: () => listeners.size,
    captured: () => captured,
  }
}

function keyEvent(key: string, modifiers: { ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean } = {}) {
  const preventDefault = vi.fn()
  return { preventDefault, event: { key, ctrlKey: false, metaKey: false, altKey: false, preventDefault, ...modifiers } }
}

afterEach(() => {
  resetTauriMock()
  vi.unstubAllGlobals()
})

describe('zoomShortcutFeature', () => {
  it('命中 Ctrl+/-/0 时上报动作并 preventDefault，捕获阶段监听', () => {
    const dom = stubDom()
    const dispose = zoomShortcutFeature()
    expect(dom.captured()).toBe(true)

    const increase = keyEvent('+', { ctrlKey: true })
    const reset = keyEvent('0', { metaKey: true })
    dom.keydown(increase.event)
    dom.keydown(reset.event)

    expect(emittedOf(TYPE_ZOOM_SHORTCUT)).toEqual([{ action: 'increase' }, { action: 'reset' }])
    expect(increase.preventDefault).toHaveBeenCalledTimes(1)
    expect(reset.preventDefault).toHaveBeenCalledTimes(1)

    dispose()
  })

  it('无关按键不上报也不拦截；dispose 后注销监听', () => {
    const dom = stubDom()
    const dispose = zoomShortcutFeature()

    const plain = keyEvent('a')
    const zoomWithoutModifier = keyEvent('+')
    dom.keydown(plain.event)
    dom.keydown(zoomWithoutModifier.event)
    expect(emittedOf(TYPE_ZOOM_SHORTCUT)).toEqual([])
    expect(plain.preventDefault).not.toHaveBeenCalled()

    dispose()
    expect(dom.listenerCount()).toBe(0)
    dom.keydown(keyEvent('+', { ctrlKey: true }).event)
    expect(emittedOf(TYPE_ZOOM_SHORTCUT)).toEqual([])
  })
})
