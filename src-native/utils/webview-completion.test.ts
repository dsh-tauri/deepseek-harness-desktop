/// <reference types="node" />
import { getEventListeners } from 'node:events'
import { createContext as createVmContext, runInContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNotificationShim, nativeMessageScript, parseNativeMessage } from './webview-bridge'

const origin = 'https://harness.test:3080'
const nonce = 'completion-nonce'

interface SessionRow {
  running: boolean
  displayTitle?: string
  title?: string
  origin?: 'subagent'
}
interface SessionStatus {
  running?: boolean
  pendingInteraction?: unknown
  completionUnread?: boolean
}

function source<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    listeners,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    publish(next: T) {
      snapshot = next
      for (const listener of listeners)
        listener()
    },
  }
}

function sessionServices(rows: Record<string, SessionRow> = { alpha: { running: false, displayTitle: '测试任务' } }) {
  const list = source({ ids: Object.keys(rows), byId: rows, phase: 'ready' })
  const sessionStatus = source(new Map<string, SessionStatus>(Object.entries(rows).map(([id, row]) => [id, { running: row.running }])))
  return { sessions: { list }, uiSession: { sessionStatus } }
}

const browsers: Array<{ window: EventTarget }> = []
function browser(services?: ReturnType<typeof sessionServices>, options: { hidden?: boolean, useGet?: boolean, login?: boolean } = {}) {
  const posts: string[] = []
  const ctx: Record<string, unknown> | undefined = services
    ? options.useGet ? { get: (name: string) => services[name as keyof typeof services] } : services
    : undefined
  const window = Object.assign(new EventTarget(), {
    top: null as unknown,
    __DSH_BOOT__: options.login ? undefined : {},
    __dshClientCtx: ctx,
    Notification: undefined as unknown as { new (title: string, options?: Record<string, unknown>): unknown },
    ReactNativeWebView: { postMessage: (raw: string) => posts.push(raw) },
  })
  window.top = window
  const styles = new Map<string, { id: string, textContent: string }>()
  const document = Object.assign(new EventTarget(), {
    hidden: options.hidden ?? true,
    readyState: 'complete',
    documentElement: { getAttribute: () => null },
    body: null,
    head: { appendChild: (style: { id: string, textContent: string }) => styles.set(style.id, style) },
    createElement: () => ({ id: '', textContent: '' }),
    getElementById: (id: string) => styles.get(id) ?? (options.login && id === 'loginForm' ? {} : null),
    querySelectorAll: () => [],
  })
  class MutationObserver {
    observe() {}
    disconnect() {}
  }
  const vm = createVmContext({ window, document, location: { origin }, MutationObserver, Event, MessageEvent, Date, setTimeout, clearTimeout })
  function inject(nextNonce = nonce) {
    expect(runInContext(createNotificationShim(origin, nextNonce), vm, { timeout: 1000 })).toBe(true)
  }
  function visibility(hidden: boolean) {
    expect(runInContext(nativeMessageScript(origin, nonce, { type: 'dsh://visibility-state', hidden }), vm, { timeout: 1000 })).toBe(true)
  }
  function notifications() {
    return posts.map(raw => parseNativeMessage(raw, `${origin}/tasks`, origin, nonce)).filter(message => message?.type === 'dsh://native-notification')
  }
  browsers.push({ window })
  return { window, inject, visibility, notifications, posts }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})
afterEach(() => {
  for (const page of browsers.splice(0))
    page.window.dispatchEvent(new Event('pagehide'))
  expect(vi.getTimerCount()).toBe(0)
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('injected DSH completion producer', () => {
  it('subscribes once to public services and produces a bounded native completion with a stable session identity', async () => {
    const services = sessionServices()
    const page = browser(services, { useGet: true })
    page.inject()
    page.inject()
    expect(services.sessions.list.listeners.size).toBe(1)
    expect(services.uiSession.sessionStatus.listeners.size).toBe(1)
    expect(page.notifications()).toEqual([])
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: true }]]))
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false, completionUnread: true }]]))
    await vi.advanceTimersByTimeAsync(249)
    expect(page.notifications()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(page.notifications()).toEqual([{
      type: 'dsh://native-notification',
      title: '测试任务',
      body: '轮次已完成',
      sessionId: 'alpha',
      tag: 'dsh-notification-alpha-1',
      silent: false,
    }])
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false, completionUnread: false }]]))
    await vi.advanceTimersByTimeAsync(1000)
    expect(page.notifications()).toHaveLength(1)
  })

  it('uses the legacy list only when the authoritative uiSession source is unavailable', async () => {
    const services = sessionServices({ alpha: { running: true, title: '旧版任务' } })
    const page = browser()
    page.window.__dshClientCtx = { sessions: services.sessions }
    page.inject()
    services.sessions.list.publish({ ids: ['alpha'], byId: { alpha: { running: false, title: '旧版任务' } }, phase: 'ready' })
    await vi.advanceTimersByTimeAsync(250)
    expect(page.notifications()).toEqual([{
      type: 'dsh://native-notification',
      title: '旧版任务',
      body: '轮次已完成',
      sessionId: 'alpha',
      tag: 'dsh-notification-alpha-1',
      silent: false,
    }])
  })

  it('does not replay preexisting idle/unread states or mistake unknown running for completion', async () => {
    const services = sessionServices()
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false, completionUnread: true }]]))
    const page = browser(services)
    page.inject()
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: true }]]))
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: undefined }]]))
    await vi.advanceTimersByTimeAsync(1000)
    expect(page.notifications()).toEqual([])
  })

  it('does not interpret a stale list stop as completion when the authoritative status is still running', async () => {
    const services = sessionServices({ alpha: { running: true } })
    const page = browser(services)
    page.inject()
    services.sessions.list.publish({ ids: ['alpha'], byId: { alpha: { running: false } }, phase: 'ready' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(page.notifications()).toEqual([])
  })

  it('cancels unstable stops, then notifies the later stable completion once', async () => {
    const services = sessionServices({ alpha: { running: true } })
    const page = browser(services)
    page.inject()
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false }]]))
    await vi.advanceTimersByTimeAsync(249)
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: true }]]))
    await vi.advanceTimersByTimeAsync(1)
    expect(page.notifications()).toEqual([])
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false }]]))
    await vi.advanceTimersByTimeAsync(250)
    expect(page.notifications()).toHaveLength(1)
  })

  it('never schedules a foreground completion or replays it on backgrounding', async () => {
    const services = sessionServices({ alpha: { running: true } })
    const page = browser(services, { hidden: false })
    page.inject()
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false }]]))
    page.visibility(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(page.notifications()).toEqual([])
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: true }]]))
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false }]]))
    page.visibility(false)
    await vi.advanceTimersByTimeAsync(250)
    expect(page.notifications()).toEqual([])
  })

  it('does not label pending interactions, removed sessions, or subagent rows as completed work', async () => {
    const services = sessionServices({ alpha: { running: true }, child: { running: true, origin: 'subagent' } })
    const page = browser(services)
    page.inject()
    services.uiSession.sessionStatus.publish(new Map([
      ['alpha', { running: false, pendingInteraction: { key: 'approval-1', kind: 'approval' } }],
      ['child', { running: false }],
    ]))
    await vi.advanceTimersByTimeAsync(250)
    expect(page.notifications()).toEqual([])
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: true }]]))
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false }]]))
    services.sessions.list.publish({ ids: [], byId: {}, phase: 'ready' })
    await vi.advanceTimersByTimeAsync(250)
    expect(page.notifications()).toEqual([])
  })

  it('bounds titles and uses a safe fallback without placing the connection URL in notification metadata', async () => {
    const services = sessionServices({ alpha: { running: true, displayTitle: `  ${'题'.repeat(300)}  ` }, beta: { running: true } })
    const page = browser(services)
    page.inject()
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false }], ['beta', { running: false }]]))
    await vi.advanceTimersByTimeAsync(250)
    expect(page.notifications().map(message => message?.title)).toEqual(['题'.repeat(256), 'DSH 会话'])
    expect(page.notifications().map(message => message?.sessionId)).toEqual(['alpha', 'beta'])
  })

  it('coalesces a real page completion notification with the synthesized fallback but preserves pending reminders', async () => {
    const services = sessionServices({ alpha: { running: true } })
    const page = browser(services)
    page.inject()
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false }]]))
    const completed = new page.window.Notification('上游完成', { body: '已结束', sessionId: 'alpha', tag: 'dsh-notification-alpha-88' })
    const pending = new page.window.Notification('需要回答', { body: '问题', sessionId: 'alpha', tag: 'dsh-notification-pending-alpha-89' })
    expect(completed).toHaveProperty('title', '上游完成')
    expect(pending).toHaveProperty('title', '需要回答')
    await vi.advanceTimersByTimeAsync(250)
    expect(page.notifications().map(message => message?.title)).toEqual(['上游完成', '需要回答'])
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: true }]]))
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false }]]))
    await vi.advanceTimersByTimeAsync(250)
    expect(page.notifications()).toHaveLength(3)
  })

  it('attaches a late context and status source while retaining only one slow retry for unavailable sources', async () => {
    const services = sessionServices({ alpha: { running: true } })
    const page = browser()
    page.inject()
    await vi.advanceTimersByTimeAsync(500)
    page.window.__dshClientCtx = { sessions: services.sessions }
    await vi.advanceTimersByTimeAsync(250)
    expect(services.sessions.list.listeners.size).toBe(1)
    page.window.__dshClientCtx = services
    await vi.advanceTimersByTimeAsync(250)
    expect(services.uiSession.sessionStatus.listeners.size).toBe(1)
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false }]]))
    await vi.advanceTimersByTimeAsync(250)
    expect(page.notifications()).toHaveLength(1)
    const unavailable = browser()
    unavailable.inject()
    await vi.advanceTimersByTimeAsync(5000)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(60000)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('disposes subscriptions and unsettled completion on pagehide and replaces the old nonce owner', async () => {
    const services = sessionServices({ alpha: { running: true } })
    const page = browser(services)
    page.inject()
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false }]]))
    page.window.dispatchEvent(new Event('pagehide'))
    expect(services.sessions.list.listeners.size).toBe(0)
    expect(services.uiSession.sessionStatus.listeners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(250)
    expect(page.notifications()).toEqual([])
    page.inject('next-nonce')
    expect(services.sessions.list.listeners.size).toBe(1)
    expect(services.uiSession.sessionStatus.listeners.size).toBe(1)
    page.inject('third-nonce')
    expect(services.sessions.list.listeners.size).toBe(1)
    expect(services.uiSession.sessionStatus.listeners.size).toBe(1)
  })

  it('attaches services exposed after the fast boot window without needing another injection', async () => {
    const services = sessionServices({ alpha: { running: true } })
    const page = browser()
    page.inject()
    await vi.advanceTimersByTimeAsync(5250)
    page.window.__dshClientCtx = services
    await vi.advanceTimersByTimeAsync(5000)
    expect(services.sessions.list.listeners.size).toBe(1)
    expect(services.uiSession.sessionStatus.listeners.size).toBe(1)
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false }]]))
    await vi.advanceTimersByTimeAsync(250)
    expect(page.notifications()).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves an already observed completion when the authoritative status service arrives during its debounce', async () => {
    const services = sessionServices({ alpha: { running: true } })
    const page = browser()
    page.window.__dshClientCtx = { sessions: services.sessions }
    page.inject()
    await vi.advanceTimersByTimeAsync(100)
    services.sessions.list.publish({ ids: ['alpha'], byId: { alpha: { running: false } }, phase: 'ready' })
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false }]]))
    page.window.__dshClientCtx = services
    await vi.advanceTimersByTimeAsync(249)
    expect(services.uiSession.sessionStatus.listeners.size).toBe(1)
    expect(page.notifications()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(page.notifications()).toHaveLength(1)
  })

  it('does not reset completion deduplication for a harmless catalog update while status still reports running', async () => {
    const services = sessionServices({ alpha: { running: true } })
    const page = browser(services)
    page.inject()
    const notification = new page.window.Notification('上游完成', { body: '已结束', sessionId: 'alpha', tag: 'dsh-notification-alpha-88' })
    expect(notification).toHaveProperty('title', '上游完成')
    services.sessions.list.publish({ ...services.sessions.list.getSnapshot() })
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false }]]))
    await vi.advanceTimersByTimeAsync(250)
    expect(page.notifications().map(message => message?.title)).toEqual(['上游完成'])
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: true }]]))
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false }]]))
    await vi.advanceTimersByTimeAsync(250)
    expect(page.notifications()).toHaveLength(2)
  })

  it.each([
    { title: 'x'.repeat(257) },
    { title: '   ' },
    { body: 'x'.repeat(4097) },
    { body: '\u0000'.repeat(4096) },
    { tag: `dsh-notification-${'x'.repeat(256)}-88` },
    { sessionId: 'x'.repeat(257) },
  ])('does not let a rejected upstream completion suppress the bounded local fallback: %j', async (invalid) => {
    const services = sessionServices({ alpha: { running: true, displayTitle: '测试任务' } })
    const page = browser(services)
    page.inject()
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false }]]))
    const notification = new page.window.Notification(invalid.title ?? '上游完成', {
      body: '已结束',
      sessionId: 'alpha',
      tag: 'dsh-notification-alpha-88',
      ...invalid,
    })
    expect(notification).toHaveProperty('title', invalid.title ?? '上游完成')
    await vi.advanceTimersByTimeAsync(250)
    expect(page.notifications()).toEqual([{
      type: 'dsh://native-notification',
      title: '测试任务',
      body: '轮次已完成',
      sessionId: 'alpha',
      tag: 'dsh-notification-alpha-1',
      silent: false,
    }])
  })

  it('releases document listeners and restores the same nonce after a persisted page is reinjected', async () => {
    const services = sessionServices({ alpha: { running: true } })
    const page = browser(services)
    page.inject()
    const PreviousNotification = page.window.Notification
    expect(getEventListeners(page.window, 'message')).toHaveLength(1)
    page.window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }))
    expect(getEventListeners(page.window, 'message')).toHaveLength(0)
    expect(getEventListeners(page.window, 'pagehide')).toHaveLength(0)
    page.window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
    page.inject()
    expect(services.sessions.list.listeners.size).toBe(1)
    expect(services.uiSession.sessionStatus.listeners.size).toBe(1)
    expect(getEventListeners(page.window, 'message')).toHaveLength(1)
    const stale = new PreviousNotification('旧页面回调', { tag: 'stale-callback' })
    expect(stale).toHaveProperty('title', '旧页面回调')
    expect(page.notifications()).toEqual([])
    services.uiSession.sessionStatus.publish(new Map([['alpha', { running: false }]]))
    await vi.advanceTimersByTimeAsync(250)
    expect(page.notifications()).toHaveLength(1)
    page.inject('second-owner')
    page.inject('third-owner')
    expect(getEventListeners(page.window, 'message')).toHaveLength(1)
    expect(getEventListeners(page.window, 'pagehide')).toHaveLength(1)
  })

  it('observes a catalog in linear membership work instead of searching the full list for each row', () => {
    const rows = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`session-${index}`, { running: false }]))
    const services = sessionServices(rows)
    const membership = vi.spyOn(services.sessions.list.getSnapshot().ids, 'indexOf')
    const page = browser(services)
    page.inject()
    expect(membership.mock.calls.length).toBeLessThanOrEqual(1)
    expect(page.notifications()).toEqual([])
  })

  it('leaves a login page without a context free of session subscriptions and retry timers', async () => {
    const page = browser(undefined, { login: true })
    page.inject()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(page.notifications()).toEqual([])
  })
})
