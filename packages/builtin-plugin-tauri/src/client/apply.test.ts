import type { ClientContext } from './types'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from './index'
import { dispatchEvent, emitted, emittedOf, listenerCount, resetTauriMock, tauriMock } from './test-utils/tauri-mock'

vi.mock('./service/tauri', async () => (await import('./test-utils/tauri-mock')).tauriMock)

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
  sent: typeof emitted
  styles: HTMLStyleElement[]
  paint: () => void
  pendingFrames: () => number
  dispatch: (type: string) => void
  keydown: (event: KeyboardEvent) => void
}

function stubEnv(): Harness {
  const windowListeners = new Map<(event: MessageEvent) => void, string>()
  const documentListeners = new Map<(event: KeyboardEvent) => void, string>()
  const storage = new Map<string, string>()
  vi.stubGlobal('window', {
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
    sent: emitted,
    styles,
    paint() {
      const batch = [...frames.values()]
      frames.clear()
      batch.forEach(callback => callback(16))
    },
    pendingFrames: () => frames.size,
    dispatch: type => dispatchEvent(type),
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
  resetTauriMock()
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
    const bridge = await ctx.plugin({ inject, apply } as unknown as Parameters<typeof ctx.plugin>[0])
    env.paint()
    expect(emittedOf('dsh://style')).toContainEqual({ sidebar: null, marked: null, frame: null, colorScheme: 'light' })
    env.dispatch('dsh://sidebar:toggle')
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
    const bridge = await ctx.plugin({ inject, apply } as unknown as Parameters<typeof ctx.plugin>[0])
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
    expect(emittedOf('dsh://style')).toContainEqual({ sidebar: null, marked: null, frame: null, colorScheme: 'light' })
    expect(emittedOf('dsh://sidebar:collapsed')).toContainEqual({ collapsed: false })
    env.dispatch('dsh://sidebar:toggle')
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
    env.dispatch('dsh://session:new')
    expect(startSession).toHaveBeenCalledTimes(1)
    env.dispatch('dsh://workspace:add')
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledWith('ws-1'))
    expect(create).toHaveBeenCalledWith({ path: '/workspace' })

    const preventDefault = vi.fn()
    env.keydown({ key: '+', ctrlKey: true, preventDefault } as unknown as KeyboardEvent)
    expect(emittedOf('dsh://zoom-shortcut')).toContainEqual({ action: 'increase' })
    expect(preventDefault).toHaveBeenCalledTimes(1)

    expect(env.labels).toEqual(EXPECTED_LABELS)
    expect(env.styles).toHaveLength(1)
    expect(tauriMock.invoke).not.toHaveBeenCalledWith('report_plugin_error', expect.anything())
    expect(listenerCount()).toBe(3)
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
