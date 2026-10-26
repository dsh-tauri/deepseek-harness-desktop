import type { ClientContext, ParentMessage } from './types'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from './index'

// effect 标签是 `ctx.effect` 的卸载日志标识：与 `client/apply.ts` 逐字一致。
const EXPECTED_LABELS = [
  'dsh-tauri: key repeat normalization (issue #1172)',
  'dsh-tauri: appearance',
  'dsh-tauri: style (sidebar background)',
  'dsh-tauri: sidebar (toggle command + collapsed report)',
  'dsh-tauri: navigation (session target, new session, add workspace)',
  'dsh-tauri: zoom shortcuts (ctrl/cmd +/-/0)',
  'dsh-tauri: sidebar tweaks (hide collapse toggle, center brand)',
  'dsh-tauri: sidebar full window (open-in-new-window button + full-screen setup)',
  'dsh-tauri: account sign-in (auto-open the authorize url)',
  'dsh-tauri: shortcuts (catalog report + edit commands)',
]

/** 假 MutationObserver：只保证 controller.observe 可用。 */
class FakeMutationObserver {
  constructor(_callback: MutationCallback) {}

  observe(): void {}

  disconnect(): void {}

  takeRecords(): MutationRecord[] {
    return []
  }
}

interface Harness {
  labels: string[]
  windowListeners: () => number
  documentListeners: () => number
  sent: ParentMessage[]
  styles: HTMLStyleElement[]
  paint: () => void
  pendingFrames: () => number
  dispatch: (data: ParentMessage) => void
  keydown: (event: KeyboardEvent) => void
}

/** 装上 DOM 假实现（node 环境无 jsdom）。 */
function stubEnv(): Harness {
  const windowListeners = new Map<(event: MessageEvent) => void, string>()
  const documentListeners = new Map<(event: KeyboardEvent) => void, string>()
  const sent: ParentMessage[] = []
  const parent = { postMessage: (message: ParentMessage) => sent.push(message) }
  const storage = new Map<string, string>()
  vi.stubGlobal('window', {
    parent,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value)
      },
    },
    addEventListener: (type: string, handler: (event: MessageEvent) => void) => windowListeners.set(handler, type),
    removeEventListener: (_type: string, handler: (event: MessageEvent) => void) => windowListeners.delete(handler),
  })
  const styles: HTMLStyleElement[] = []
  const head = {
    querySelector: () => styles[0] ?? null,
    insertBefore: (style: HTMLStyleElement) => styles.push(style),
    removeChild: (style: HTMLStyleElement) => styles.splice(styles.indexOf(style), 1),
  }
  vi.stubGlobal('document', {
    body: {},
    head,
    // 移动抽屉归属标记挂在 documentElement 上，桌面假实现里始终未设置。
    documentElement: { style: { colorScheme: 'light' }, hasAttribute: () => false },
    createElement: () => ({ setAttribute: () => {}, textContent: '', parentElement: head }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type: string, handler: (event: KeyboardEvent) => void) => documentListeners.set(handler, type),
    removeEventListener: (_type: string, handler: (event: KeyboardEvent) => void) => documentListeners.delete(handler),
  })
  vi.stubGlobal('MutationObserver', FakeMutationObserver)
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  return {
    labels: [],
    sent,
    styles,
    paint() {
      const batch = [...frames.values()]
      frames.clear()
      batch.forEach(callback => callback(16))
    },
    pendingFrames: () => frames.size,
    dispatch(data) {
      for (const [handler, type] of windowListeners) {
        if (type === 'message')
          handler({ source: window.parent, data } as MessageEvent)
      }
    },
    keydown(event) {
      for (const [handler, type] of documentListeners) {
        if (type === 'keydown')
          handler(event)
      }
    },
    windowListeners: () => windowListeners.size,
    documentListeners: () => documentListeners.size,
  }
}

const disposers: (() => void | Promise<void>)[] = []

/** 最小客户端 ctx：effect 按 cordis 的 `callback.call(fiber)` 语义绑定 this。 */
function fakeCtx(labels: string[]): ClientContext {
  const ctx = {
    effect(callback: (this: unknown) => () => void, label?: string) {
      if (label !== undefined)
        labels.push(label)
      const dispose = callback.call({ ctx: this })
      disposers.push(dispose)
      return dispose
    },
    inject(_names: string[], callback: (scoped: ClientContext) => void) {
      callback(ctx as unknown as ClientContext)
    },
    layout: { toggleSidebar: () => {} },
    // 可选服务读取（`ctx.get`）与属性同源：老核心没有 `shortcuts`，属性面也不存在。
    get(name: string): unknown {
      return Reflect.get(ctx, name)
    },
  }
  return ctx as unknown as ClientContext
}

interface NavigationWindow {
  __DSH_NAVIGATION__?: { sessionId?: unknown }
}

function injectSessionTarget(sessionId: string): void {
  (window as unknown as NavigationWindow).__DSH_NAVIGATION__ = { sessionId }
}

function injectedSessionTarget(): unknown {
  return (window as unknown as NavigationWindow).__DSH_NAVIGATION__
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(async () => {
  for (const dispose of disposers.splice(0))
    await dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('apply', () => {
  it('会话服务后到时仍能消费注入的目标会话，不创建新会话', async () => {
    const env = stubEnv()
    injectSessionTarget('target')
    const ctx = new Context()
    disposers.push(ctx.fiber.dispose)
    const toggleSidebar = vi.fn()
    ctx.provide('layout', { toggleSidebar })
    ctx.provide('theme', {})
    const bridge = await ctx.plugin({ inject, apply })
    env.paint()
    expect(env.sent).toContainEqual({ type: 'dsh://style', sidebar: null, marked: null, frame: null, colorScheme: 'light' })
    env.dispatch({ type: 'dsh://sidebar:toggle' })
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
    const openSession = vi.fn()
    const create = vi.fn()
    const startSession = vi.fn()

    ctx.provide('sessions', {
      list: { getSnapshot: () => ({ ids: ['target'] }), subscribe: vi.fn() },
      create,
    })
    await bridge.await()
    expect(injectedSessionTarget()).toBeUndefined()
    ctx.provide('uiWorkspace', { openSession, startSession })
    await vi.advanceTimersByTimeAsync(500)

    expect(openSession.mock.calls).toEqual([['target']])
    expect(create).not.toHaveBeenCalled()
    expect(startSession).not.toHaveBeenCalled()
  })

  it('会话服务撤销再重建时不重复消费注入的目标会话', async () => {
    const env = stubEnv()
    injectSessionTarget('target')
    const ctx = new Context()
    disposers.push(ctx.fiber.dispose)
    ctx.provide('layout', { toggleSidebar: vi.fn() })
    ctx.provide('theme', {})
    const sessions = { list: { getSnapshot: () => ({ ids: ['target'] }), subscribe: vi.fn() } }
    const removeSessions = ctx.provide('sessions', sessions)
    const openSession = vi.fn()
    ctx.provide('uiWorkspace', { openSession })
    const bridge = await ctx.plugin({ inject, apply })
    expect(openSession).toHaveBeenCalledTimes(1)

    await removeSessions()
    ctx.provide('sessions', { ...sessions })
    await bridge.await()
    await vi.advanceTimersByTimeAsync(500)
    expect(openSession).toHaveBeenCalledTimes(1)

    await bridge.dispose()
    expect(env.windowListeners()).toBe(0)
    expect(env.documentListeners()).toBe(0)
    expect(env.styles).toEqual([])
    expect(env.pendingFrames()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('独立浏览器跳过桌面 effect，不拦截原生缩放快捷键', () => {
    const env = stubEnv()
    Object.defineProperty(window, 'parent', { value: window })
    const preventDefault = vi.fn()

    expect(() => apply(fakeCtx(env.labels))).not.toThrow()
    env.keydown({ key: '+', ctrlKey: true, preventDefault } as unknown as KeyboardEvent)

    expect(env.labels).toEqual([])
    expect(env.windowListeners()).toBe(0)
    expect(env.documentListeners()).toBe(0)
    expect(env.sent).toEqual([])
    expect(env.styles).toEqual([])
    expect(preventDefault).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['window', 'document'])('缺少 %s 时不启动桌面 effect', (globalName) => {
    const env = stubEnv()
    vi.stubGlobal(globalName, undefined)

    expect(() => apply(fakeCtx(env.labels))).not.toThrow()

    expect(env.labels).toEqual([])
    expect(env.windowListeners()).toBe(0)
    expect(env.documentListeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('内嵌页面登记桌面 effect 并保留样式、侧边栏、导航、缩放桥', async () => {
    const env = stubEnv()

    const toggleSidebar = vi.fn()
    const startSession = vi.fn()
    const pickDirectory = vi.fn(async () => '/workspace')
    const create = vi.fn(async () => ({ workspaceId: 'ws-1' }))
    const ctx = Object.assign(fakeCtx(env.labels), {
      layout: { toggleSidebar },
      workspaces: { create },
      uiWorkspace: { startSession, pickDirectory },
    })

    apply(ctx)

    expect(env.pendingFrames()).toBe(1)
    env.paint()
    expect(env.sent).toContainEqual({ type: 'dsh://style', sidebar: null, marked: null, frame: null, colorScheme: 'light' })
    expect(env.sent).toContainEqual({ type: 'dsh://sidebar:collapsed', collapsed: false })
    env.dispatch({ type: 'dsh://sidebar:toggle' })
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
    env.dispatch({ type: 'dsh://session:new' })
    expect(startSession).toHaveBeenCalledTimes(1)
    env.dispatch({ type: 'dsh://workspace:add' })
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledWith('ws-1'))
    expect(create).toHaveBeenCalledWith({ path: '/workspace' })

    const preventDefault = vi.fn()
    env.keydown({ key: '+', ctrlKey: true, preventDefault } as unknown as KeyboardEvent)
    expect(env.sent).toContainEqual({ type: 'dsh://zoom-shortcut', action: 'increase' })
    expect(preventDefault).toHaveBeenCalledTimes(1)

    expect(env.labels).toEqual(EXPECTED_LABELS)
    expect(env.styles).toHaveLength(1)
    expect(env.sent.filter(message => message.type === 'dsh://plugin-error')).toEqual([])
    expect(env.windowListeners()).toBe(4)
    expect(env.documentListeners()).toBe(5)

    for (const dispose of disposers.splice(0))
      await dispose()
    await vi.waitFor(() => {
      expect(env.windowListeners()).toBe(0)
      expect(env.documentListeners()).toBe(0)
      expect(env.styles).toEqual([])
      expect(env.pendingFrames()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
