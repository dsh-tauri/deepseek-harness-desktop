import { afterEach, describe, expect, it, vi } from 'vitest'
import { keyRepeatFeature } from './key-repeat'

type Handler = (event: unknown) => void

function stubDom() {
  const listeners = new Map<string, Set<Handler>>()
  const windowListeners = new Map<string, Set<Handler>>()
  const add = (map: Map<string, Set<Handler>>) => (type: string, handler: Handler) => {
    map.set(type, (map.get(type) ?? new Set()).add(handler))
  }
  const remove = (map: Map<string, Set<Handler>>) => (type: string, handler: Handler) => {
    map.get(type)?.delete(handler)
  }
  vi.stubGlobal('document', { addEventListener: add(listeners), removeEventListener: remove(listeners) })
  vi.stubGlobal('window', { addEventListener: add(windowListeners), removeEventListener: remove(windowListeners) })
  return {
    fire: (type: string, event: unknown) => listeners.get(type)?.forEach(handler => handler(event)),
    fireWindow: (type: string) => windowListeners.get(type)?.forEach(handler => handler({})),
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  }
}

function key(code: string, repeat: boolean, isTrusted = true) {
  return { code, key: code, repeat, isTrusted }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('keyRepeatFeature', () => {
  it('首次按下却被报告为 repeat 的 keydown 被改写为 false', () => {
    const dom = stubDom()
    const dispose = keyRepeatFeature()
    const event = key('Enter', true)
    dom.fire('keydown', event)
    expect(event.repeat).toBe(false)
    dispose()
  })

  it('同一按键未松开的后续 keydown 保持 repeat 为 true', () => {
    const dom = stubDom()
    const dispose = keyRepeatFeature()
    dom.fire('keydown', key('Enter', true))
    const held = key('Enter', true)
    dom.fire('keydown', held)
    expect(held.repeat).toBe(true)
    dispose()
  })

  it('keyup 之后再次按下被改写为 false', () => {
    const dom = stubDom()
    const dispose = keyRepeatFeature()
    dom.fire('keydown', key('Enter', true))
    dom.fire('keyup', key('Enter', false))
    const again = key('Enter', true)
    dom.fire('keydown', again)
    expect(again.repeat).toBe(false)
    dispose()
  })

  it('window blur 后按下状态清空', () => {
    const dom = stubDom()
    const dispose = keyRepeatFeature()
    dom.fire('keydown', key('Enter', true))
    dom.fireWindow('blur')
    const after = key('Enter', true)
    dom.fire('keydown', after)
    expect(after.repeat).toBe(false)
    dispose()
  })

  it('不同按键各自独立判定', () => {
    const dom = stubDom()
    const dispose = keyRepeatFeature()
    dom.fire('keydown', key('ShiftLeft', true))
    const other = key('KeyA', true)
    dom.fire('keydown', other)
    expect(other.repeat).toBe(false)
    dispose()
  })

  it('非可信事件不改写，dispose 后注销监听', () => {
    const dom = stubDom()
    const dispose = keyRepeatFeature()
    const synthetic = key('Enter', true, false)
    dom.fire('keydown', synthetic)
    expect(synthetic.repeat).toBe(true)
    dispose()
    expect(dom.count()).toBe(0)
  })
})
