/// <reference types="node" />
import { createContext as createVmContext, runInContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNotificationShim, nativeMessageScript, parseNativeMessage } from './webview-bridge'

const origin = 'https://harness.test:3080'
const nonce = 'bridge-nonce'
const nativeUrl = `${origin}/sessions?session=session-alpha`
const payload = {
  type: 'dsh://native-notification',
  title: 'Response complete',
  body: 'Your answer is ready',
  sessionId: 'session-alpha',
  tag: 'dsh-notification-session-alpha-17',
  silent: false,
}

function envelope(notification: unknown = payload): string {
  return JSON.stringify({ channel: 'dsh-bridge', origin, nonce, payload: notification })
}

interface BrowserNotification {
  title: string
  body: string
  tag: string
  onclick: ((event: Event) => void) | null
  close: () => void
}

interface NotificationConstructor {
  new (title: unknown, options?: Record<string, unknown>): BrowserNotification
  permission: string
  requestPermission: () => Promise<string>
}

interface SessionNode {
  getAttribute: (name: string) => string | null
  click: () => void
}

interface BrowserWindow {
  top: unknown
  Notification?: NotificationConstructor
  ReactNativeWebView?: { postMessage: (message: string) => void }
  __dshBridgeNonce?: string
  __dshBridgeReceive?: (data: Record<string, unknown>) => void
  __DSH_BOOT__?: Record<string, unknown>
  __dshClientCtx?: {
    get?: (name: string) => unknown
    uiWorkspace?: { openSession: (sessionId: string) => void }
    sessions?: { open: (sessionId: string) => void }
  }
  addEventListener: (type: string, listener: EventListener, options?: AddEventListenerOptions) => void
  removeEventListener: (type: string, listener: EventListener, options?: EventListenerOptions) => void
  dispatchEvent: (event: Event) => boolean
}

class BrowserMessageEvent extends Event {
  readonly data: unknown
  readonly origin: string
  readonly source: unknown

  constructor(type: string, options: { data?: unknown, origin?: string, source?: unknown } = {}) {
    super(type)
    this.data = options.data
    this.origin = options.origin ?? ''
    this.source = options.source ?? null
  }
}

function browserElement() {
  const attributes = new Map<string, string>()
  return {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    hasAttribute: (name: string) => attributes.has(name),
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  }
}

interface BrowserStyle {
  id: string
  textContent: string
  remove: () => void
}

function createBrowser(options: { locationOrigin?: string, topFrame?: boolean, hidden?: boolean, nodes?: SessionNode[], readyState?: 'loading' | 'complete', login?: boolean, rootAvailable?: boolean } = {}) {
  const posts = vi.fn<(message: string) => void>()
  const windowEvents = new EventTarget()
  const documentEvents = new EventTarget()
  const window: BrowserWindow = {
    top: null,
    ReactNativeWebView: { postMessage: posts },
    addEventListener: vi.fn((type: string, listener: EventListener, options?: AddEventListenerOptions) => windowEvents.addEventListener(type, listener, options)),
    removeEventListener: vi.fn((type: string, listener: EventListener, options?: EventListenerOptions) => windowEvents.removeEventListener(type, listener, options)),
    dispatchEvent: vi.fn((event: Event) => windowEvents.dispatchEvent(event)),
  }
  window.top = options.topFrame === false ? {} : window
  const styles = new Map<string, BrowserStyle>()
  const appendChild = vi.fn((style: BrowserStyle) => {
    styles.set(style.id, style)
  })
  const documentElement = { ...browserElement(), appendChild }
  const body = browserElement()
  const mutations: Array<{ callback: () => void, observe: ReturnType<typeof vi.fn>, disconnect: ReturnType<typeof vi.fn> }> = []
  class BrowserMutationObserver {
    callback: () => void
    observe = vi.fn()
    disconnect = vi.fn()

    constructor(callback: () => void) {
      this.callback = callback
      mutations.push(this)
    }
  }
  const document = {
    hidden: options.hidden ?? false,
    visibilityState: options.hidden ? 'hidden' : 'visible',
    readyState: options.readyState ?? 'complete',
    documentElement: options.rootAvailable === false ? null : documentElement,
    body: options.rootAvailable === false ? null : body,
    head: options.rootAvailable === false ? null : { appendChild },
    createElement: vi.fn((tag: string) => {
      expect(tag).toBe('style')
      const style: BrowserStyle = {
        id: '',
        textContent: '',
        remove: () => {
          styles.delete(style.id)
        },
      }
      return style
    }),
    getElementById: vi.fn((id: string) => styles.get(id) ?? (options.login && id === 'loginForm' ? {} : null)),
    querySelectorAll: vi.fn<(selector: string) => SessionNode[]>().mockReturnValue(options.nodes ?? []),
    addEventListener: vi.fn((type: string, listener: EventListener, eventOptions?: AddEventListenerOptions) => documentEvents.addEventListener(type, listener, eventOptions)),
    removeEventListener: vi.fn((type: string, listener: EventListener, eventOptions?: EventListenerOptions) => documentEvents.removeEventListener(type, listener, eventOptions)),
    dispatchEvent: vi.fn((event: Event) => documentEvents.dispatchEvent(event)),
  }
  const location = { origin: options.locationOrigin ?? origin }
  const context = createVmContext({ window, document, location, MutationObserver: BrowserMutationObserver, Event, MessageEvent: BrowserMessageEvent, Date, setTimeout, clearTimeout })
  function run(script: string): unknown {
    return runInContext(script, context, { timeout: 1000 })
  }
  function inject(injectedNonce = nonce): NotificationConstructor {
    expect(run(createNotificationShim(origin, injectedNonce))).toBe(true)
    const Notification = window.Notification
    if (!Notification)
      throw new Error('Notification shim was not installed')
    return Notification
  }
  function postMessage(data: unknown, eventOrigin = origin, source: unknown = window) {
    window.dispatchEvent(new BrowserMessageEvent('message', { data, origin: eventOrigin, source }))
  }
  return { window, document, documentElement, body, styles, appendChild, mutations, location, posts, run, inject, postMessage }
}

function sessionNode(attributes: Record<string, string>): SessionNode {
  return { getAttribute: name => attributes[name] ?? null, click: vi.fn<() => void>() }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('parseNativeMessage', () => {
  it('accepts a trusted main-page envelope with complete notification metadata', () => {
    expect(parseNativeMessage(envelope(), nativeUrl, origin, nonce)).toEqual({
      type: 'dsh://native-notification',
      title: 'Response complete',
      body: 'Your answer is ready',
      sessionId: 'session-alpha',
      tag: 'dsh-notification-session-alpha-17',
      silent: false,
    })
  })

  it('normalizes omitted optional metadata without changing an empty body', () => {
    expect(parseNativeMessage(envelope({ type: 'dsh://native-notification', title: 'Ready', body: '' }), nativeUrl, origin, nonce)).toEqual({
      type: 'dsh://native-notification',
      title: 'Ready',
      body: '',
      tag: '',
      sessionId: '',
      silent: false,
    })
  })

  it('accepts the exact title, body, tag, and session-length boundaries', () => {
    expect(parseNativeMessage(envelope({
      type: 'dsh://native-notification',
      title: 't'.repeat(256),
      body: 'b'.repeat(4096),
      tag: 'g'.repeat(256),
      sessionId: 's'.repeat(256),
      silent: true,
    }), nativeUrl, origin, nonce)).toEqual({
      type: 'dsh://native-notification',
      title: 't'.repeat(256),
      body: 'b'.repeat(4096),
      tag: 'g'.repeat(256),
      sessionId: 's'.repeat(256),
      silent: true,
    })
  })

  it.each(['', '{invalid', 'null', '[]', '"message"', '17', 'true'])('rejects malformed or non-record JSON %j', (raw) => {
    expect(parseNativeMessage(raw, nativeUrl, origin, nonce)).toBeNull()
  })

  it.each([
    {},
    { channel: 'other-channel', origin, nonce, payload },
    { channel: 'dsh-bridge', origin, payload },
    { channel: 'dsh-bridge', origin, nonce: 'wrong-nonce', payload },
    { channel: 'dsh-bridge', nonce, payload },
    { channel: 'dsh-bridge', origin: `${origin}/`, nonce, payload },
    { channel: 'dsh-bridge', origin: 'https://evil.test:3080', nonce, payload },
  ])('rejects an unauthenticated native envelope %j', (value) => {
    expect(parseNativeMessage(JSON.stringify(value), nativeUrl, origin, nonce)).toBeNull()
  })

  it.each([
    'https://evil.test:3080/',
    'http://harness.test:3080/',
    'https://harness.test:3081/',
    'about:blank',
    'file:///sessions',
    'javascript:alert(1)',
    'not-a-url',
  ])('rejects an envelope sent from an untrusted native URL %s', (url) => {
    expect(parseNativeMessage(envelope(), url, origin, nonce)).toBeNull()
  })

  it.each([
    null,
    [],
    {},
    { ...payload, type: 'dsh://focus-session' },
    { ...payload, title: undefined },
    { ...payload, title: 17 },
    { ...payload, title: '' },
    { ...payload, title: ' \n\t' },
    { ...payload, title: 't'.repeat(257) },
    { ...payload, body: undefined },
    { ...payload, body: null },
    { ...payload, body: 'b'.repeat(4097) },
    { ...payload, tag: null },
    { ...payload, tag: 17 },
    { ...payload, tag: 'g'.repeat(257) },
    { ...payload, sessionId: null },
    { ...payload, sessionId: 17 },
    { ...payload, sessionId: 's'.repeat(257) },
    { ...payload, silent: null },
    { ...payload, silent: 'true' },
  ])('rejects an invalid notification payload %j', (value) => {
    expect(parseNativeMessage(envelope(value), nativeUrl, origin, nonce)).toBeNull()
  })

  it('accepts the exact raw-message limit but rejects one extra character', () => {
    const valid = envelope()
    const boundary = valid.padEnd(16384, ' ')

    expect(parseNativeMessage(boundary, nativeUrl, origin, nonce)).toEqual(payload)
    expect(parseNativeMessage(`${boundary} `, nativeUrl, origin, nonce)).toBeNull()
  })
})

describe('trusted WebView theme and touch styling', () => {
  it.each(['light', 'dark', 'system'] as const)('accepts only the canonical theme source %s through authenticated IPC', (theme) => {
    expect(parseNativeMessage(envelope({ type: 'dsh://theme-state', theme }), nativeUrl, origin, nonce)).toEqual({ type: 'dsh://theme-state', theme })
    expect(parseNativeMessage(envelope({ type: 'dsh://theme-state', theme }), nativeUrl, origin, 'stale-nonce')).toBeNull()
    expect(parseNativeMessage(envelope({ type: 'dsh://theme-state', theme }), 'https://foreign.test/', origin, nonce)).toBeNull()
  })

  it.each([undefined, null, 1, '', 'sepia', 'LIGHT', 'auto'])('rejects unsupported theme values %j', (theme) => {
    expect(parseNativeMessage(envelope({ type: 'dsh://theme-state', theme }), nativeUrl, origin, nonce)).toBeNull()
  })

  it('installs only tap transparency, repairs a removed style, and preserves same-nonce bridge identity', () => {
    const browser = createBrowser()
    const Notification = browser.inject()
    const receive = browser.window.__dshBridgeReceive
    const style = browser.styles.get('dsh-bridge-tap-highlight')

    expect(style?.textContent).toBe('* { -webkit-tap-highlight-color: transparent; }')
    expect(browser.styles.size).toBe(1)
    expect(browser.document.createElement).toHaveBeenCalledExactlyOnceWith('style')
    expect(browser.inject()).toBe(Notification)
    expect(browser.window.__dshBridgeReceive).toBe(receive)
    expect(browser.styles.size).toBe(1)
    expect(browser.document.createElement).toHaveBeenCalledTimes(1)
    style?.remove()
    expect(browser.styles.size).toBe(0)
    browser.inject()
    expect(browser.styles.get('dsh-bridge-tap-highlight')?.textContent).toBe('* { -webkit-tap-highlight-color: transparent; }')
    expect(browser.document.createElement).toHaveBeenCalledTimes(2)
    expect(browser.window.__dshBridgeReceive).toBe(receive)
    expect(browser.posts).not.toHaveBeenCalled()
  })

  it('defers touch styling until the root exists when injected before HTML content', () => {
    const browser = createBrowser({ rootAvailable: false, readyState: 'loading' })
    browser.inject()
    expect(browser.styles.size).toBe(0)
    expect(browser.document.createElement).not.toHaveBeenCalled()
    browser.document.documentElement = browser.documentElement
    browser.document.head = { appendChild: browser.appendChild }
    browser.document.body = browser.body
    browser.document.dispatchEvent(new Event('DOMContentLoaded'))
    browser.document.dispatchEvent(new Event('DOMContentLoaded'))

    expect(browser.styles.get('dsh-bridge-tap-highlight')?.textContent).toBe('* { -webkit-tap-highlight-color: transparent; }')
    expect(browser.styles.size).toBe(1)
    expect(browser.document.createElement).toHaveBeenCalledExactlyOnceWith('style')
  })

  it.each([{ locationOrigin: 'https://evil.test:3080' }, { topFrame: false }])('does not style or observe an untrusted document %j', (options) => {
    const browser = createBrowser(options)
    browser.documentElement.setAttribute('data-ds-theme-source', 'light')
    browser.window.__DSH_BOOT__ = {}
    browser.run(createNotificationShim(origin, nonce))

    expect(browser.styles.size).toBe(0)
    expect(browser.document.createElement).not.toHaveBeenCalled()
    expect(browser.mutations).toEqual([])
    expect(browser.posts).not.toHaveBeenCalled()
  })

  it('mirrors the DSH-owned theme source only after readiness and follows mutations without duplicate observers or messages', () => {
    const browser = createBrowser({ readyState: 'loading' })
    browser.window.__DSH_BOOT__ = {}
    browser.documentElement.setAttribute('data-ds-theme-source', 'light')
    browser.inject()
    expect(browser.posts).not.toHaveBeenCalled()
    browser.document.readyState = 'complete'
    browser.window.dispatchEvent(new Event('load'))

    expect(browser.posts.mock.calls.map(([raw]) => parseNativeMessage(raw, nativeUrl, origin, nonce))).toEqual([
      { type: 'dsh://bridge-ready' },
      { type: 'dsh://theme-state', theme: 'light' },
    ])
    expect(browser.mutations).toHaveLength(1)
    expect(browser.mutations[0]!.observe).toHaveBeenCalledWith(browser.documentElement, { attributes: true, attributeFilter: ['data-ds-theme-source'] })
    browser.inject()
    browser.mutations[0]!.callback()
    expect(browser.posts).toHaveBeenCalledTimes(2)
    browser.documentElement.setAttribute('data-ds-theme-source', 'dark')
    browser.mutations[0]!.callback()
    browser.documentElement.setAttribute('data-ds-theme-source', 'system')
    browser.mutations[0]!.callback()
    expect(browser.posts.mock.calls.slice(2).map(([raw]) => parseNativeMessage(raw, nativeUrl, origin, nonce))).toEqual([
      { type: 'dsh://theme-state', theme: 'dark' },
      { type: 'dsh://theme-state', theme: 'system' },
    ])
    browser.window.dispatchEvent(new Event('pagehide'))
    expect(browser.mutations[0]!.disconnect).toHaveBeenCalledTimes(1)
  })

  it('follows legacy DSH body palette changes when no native theme-source marker is exposed', () => {
    const browser = createBrowser()
    browser.window.__dshClientCtx = {}
    browser.body.setAttribute('data-ds-dark-theme', '')
    browser.inject()
    expect(browser.posts.mock.calls.map(([raw]) => parseNativeMessage(raw, nativeUrl, origin, nonce))).toEqual([
      { type: 'dsh://bridge-ready' },
      { type: 'dsh://theme-state', theme: 'dark' },
    ])
    expect(browser.mutations).toHaveLength(1)
    expect(browser.mutations[0]!.observe).toHaveBeenCalledWith(browser.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    browser.body.removeAttribute('data-ds-dark-theme')
    browser.mutations[0]!.callback()
    expect(parseNativeMessage(browser.posts.mock.calls[2]![0], nativeUrl, origin, nonce)).toEqual({ type: 'dsh://theme-state', theme: 'light' })
  })

  it('does not infer a light theme from a marker-free login page or incomplete arbitrary HTML', () => {
    const login = createBrowser({ login: true })
    login.inject()
    expect(login.posts.mock.calls.map(([raw]) => parseNativeMessage(raw, nativeUrl, origin, nonce))).toEqual([{ type: 'dsh://bridge-ready' }])
    const unverified = createBrowser()
    unverified.documentElement.setAttribute('data-ds-theme-source', 'light')
    unverified.inject()
    unverified.mutations[0]?.callback()
    expect(unverified.posts).not.toHaveBeenCalled()
  })
})

describe('notification shim trust boundary', () => {
  it.each([
    { locationOrigin: 'https://evil.test:3080' },
    { topFrame: false },
  ])('does not install into an untrusted page or subframe %j', (options) => {
    const browser = createBrowser(options)

    expect(browser.run(createNotificationShim(origin, nonce))).toBe(true)

    expect(browser.window.Notification).toBeUndefined()
    expect(browser.window.__dshBridgeNonce).toBeUndefined()
    expect(browser.window.__dshBridgeReceive).toBeUndefined()
    expect(browser.window.addEventListener).not.toHaveBeenCalled()
    expect(browser.posts).not.toHaveBeenCalled()
  })

  it('forwards an authenticated top-window notification event through the actual native parser', () => {
    const browser = createBrowser()
    browser.inject()

    browser.postMessage(payload)

    expect(browser.posts).toHaveBeenCalledTimes(1)
    const raw = browser.posts.mock.calls[0]?.[0]
    if (raw === undefined)
      throw new Error('Native notification envelope was not posted')
    expect(JSON.parse(raw)).toEqual({ channel: 'dsh-bridge', origin: 'https://harness.test:3080', nonce: 'bridge-nonce', payload })
    expect(parseNativeMessage(raw, nativeUrl, origin, nonce)).toEqual(payload)
  })

  it.each(['https://evil.test:3080', 'http://harness.test:3080', 'null', ''])('never forwards a message with foreign origin %j', (eventOrigin) => {
    const browser = createBrowser()
    browser.inject()

    browser.postMessage(payload, eventOrigin)

    expect(browser.posts).not.toHaveBeenCalled()
  })

  it.each([{}, null])('never forwards a same-origin message from another window or missing source %j', (source) => {
    const browser = createBrowser()
    browser.inject()

    browser.postMessage(payload, origin, source)

    expect(browser.posts).not.toHaveBeenCalled()
  })

  it('never forwards a same-origin notification event with omitted source', () => {
    const browser = createBrowser()
    browser.inject()

    browser.window.dispatchEvent(new BrowserMessageEvent('message', { origin, data: payload }))

    expect(browser.posts).not.toHaveBeenCalled()
  })

  it('ignores page message types outside the notification contract', () => {
    const browser = createBrowser()
    browser.inject()

    browser.postMessage({ type: 'dsh://focus-session', sessionId: 'session-alpha' })

    expect(browser.posts).not.toHaveBeenCalled()
  })

  it('does not throw when the native WebView postMessage endpoint is unavailable', () => {
    const browser = createBrowser()
    browser.window.ReactNativeWebView = undefined
    const Notification = browser.inject()

    expect(() => new Notification('Ready', { body: 'Done', tag: 'no-native-endpoint' })).not.toThrow()
    expect(browser.posts).not.toHaveBeenCalled()
  })
})

describe('notification constructor contract', () => {
  it('posts the title, body, tag, explicit session, and silent selection of a new Notification', () => {
    const browser = createBrowser()
    const Notification = browser.inject()

    const instance = new Notification('Response complete', { body: 'Your answer is ready', tag: 'dsh-notification-session-alpha-17', sessionId: 'explicit-session', silent: true })

    expect(instance.title).toBe('Response complete')
    expect(instance.body).toBe('Your answer is ready')
    expect(instance.tag).toBe('dsh-notification-session-alpha-17')
    expect(browser.posts.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([{
      channel: 'dsh-bridge',
      origin: 'https://harness.test:3080',
      nonce: 'bridge-nonce',
      payload: {
        type: 'dsh://native-notification',
        title: 'Response complete',
        body: 'Your answer is ready',
        tag: 'dsh-notification-session-alpha-17',
        sessionId: 'explicit-session',
        silent: true,
      },
    }])
  })

  it.each([
    ['dsh-notification-session-alpha-17', 'session-alpha'],
    ['dsh-notification-pending-session-alpha-17', 'session-alpha'],
    ['dsh-notification-session-with-hyphens-100', 'session-with-hyphens'],
    ['connection:https://harness.test:3080', ''],
    ['dsh-notification-session-alpha-not-a-number', ''],
  ])('derives a session from native tag=%s as %s', (tag, sessionId) => {
    const browser = createBrowser()
    const Notification = browser.inject()

    const instance = new Notification('Ready', { body: 'Done', tag })

    expect(instance.tag).toBe(tag)

    expect(browser.posts.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([{
      channel: 'dsh-bridge',
      origin: 'https://harness.test:3080',
      nonce: 'bridge-nonce',
      payload: { type: 'dsh://native-notification', title: 'Ready', body: 'Done', tag, sessionId, silent: false },
    }])
  })

  it('provides granted permission without requesting a browser permission dialog', async () => {
    const browser = createBrowser()
    const Notification = browser.inject()

    expect(Notification.permission).toBe('granted')
    await expect(Notification.requestPermission()).resolves.toBe('granted')
    expect(browser.posts).not.toHaveBeenCalled()
  })

  it('assigns distinct generated tags when callers omit the tag', () => {
    const browser = createBrowser()
    const Notification = browser.inject()

    const first = new Notification('First')
    const second = new Notification('Second')

    expect(first.tag).toMatch(/^mobile-\d+-1$/)
    expect(second.tag).toMatch(/^mobile-\d+-2$/)
    expect(first.tag).not.toBe(second.tag)
    expect(first.body).toBe('')
    expect(browser.posts).toHaveBeenCalledTimes(2)
  })

  it('coerces supported title and body values while requiring boolean true for silent mode', () => {
    const browser = createBrowser()
    const Notification = browser.inject()

    const instance = new Notification(17, { body: 23, tag: 'numeric-title', silent: 'true' })

    expect(instance.title).toBe('17')
    expect(instance.body).toBe('23')

    expect(browser.posts.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([{
      channel: 'dsh-bridge',
      origin: 'https://harness.test:3080',
      nonce: 'bridge-nonce',
      payload: { type: 'dsh://native-notification', title: '17', body: '23', tag: 'numeric-title', sessionId: '', silent: false },
    }])
  })

  it('preserves the constructor and existing click callback during repeated injection', () => {
    const browser = createBrowser()
    const Notification = browser.inject()
    const instance = new Notification('Ready', { tag: 'retained-tag' })
    const onclick = vi.fn<(event: Event) => void>()
    instance.onclick = onclick

    expect(browser.inject()).toBe(Notification)
    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://notification-clicked', tag: 'retained-tag' }))

    expect(browser.window.addEventListener).toHaveBeenCalledTimes(2)
    expect(onclick).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'click' }))
    expect(browser.posts).toHaveBeenCalledTimes(1)
  })
})

describe('native visibility messages', () => {
  it('mirrors hidden and visibilityState only when native visibility actually changes', () => {
    const browser = createBrowser()
    browser.inject()
    expect(browser.document.hidden).toBe(false)
    expect(browser.document.visibilityState).toBe('visible')

    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://visibility-state', hidden: true }))
    expect(browser.document.hidden).toBe(true)
    expect(browser.document.visibilityState).toBe('hidden')
    expect(browser.document.dispatchEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'visibilitychange' }))
    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://visibility-state', hidden: true }))
    expect(browser.document.dispatchEvent).toHaveBeenCalledTimes(1)
    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://visibility-state', hidden: false }))

    expect(browser.document.hidden).toBe(false)
    expect(browser.document.visibilityState).toBe('visible')
    expect(browser.document.dispatchEvent).toHaveBeenCalledTimes(2)
  })

  it('preserves initial hidden state until the native app becomes active', () => {
    const browser = createBrowser({ hidden: true })
    browser.inject()

    expect(browser.document.hidden).toBe(true)
    expect(browser.document.visibilityState).toBe('hidden')
    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://visibility-state', hidden: false }))

    expect(browser.document.hidden).toBe(false)
    expect(browser.document.visibilityState).toBe('visible')
    expect(browser.document.dispatchEvent).toHaveBeenCalledTimes(1)
  })

  it('rejects visibility messages that bypass injection with an incorrect nonce', () => {
    const browser = createBrowser()
    browser.inject()

    browser.window.__dshBridgeReceive?.({ type: 'dsh://visibility-state', hidden: true, nonce: 'wrong-nonce' })

    expect(browser.document.hidden).toBe(false)
    expect(browser.document.visibilityState).toBe('visible')
    expect(browser.document.dispatchEvent).not.toHaveBeenCalled()
  })
})

describe('native click and focus messages', () => {
  it('invokes a retained Notification click callback once and broadcasts the native click to the page', () => {
    const browser = createBrowser()
    const Notification = browser.inject()
    const instance = new Notification('Ready', { tag: 'clicked-tag' })
    const onclick = vi.fn<(event: Event) => void>()
    instance.onclick = onclick
    const script = nativeMessageScript(origin, nonce, { type: 'dsh://notification-clicked', tag: 'clicked-tag' })

    browser.run(script)
    browser.run(script)

    expect(onclick).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'click' }))
    expect(browser.window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      origin: 'https://harness.test:3080',
      data: { type: 'dsh://notification-clicked', tag: 'clicked-tag', nonce: 'bridge-nonce' },
    }))
    expect(browser.posts).toHaveBeenCalledTimes(1)
  })

  it('does not invoke a callback for a closed Notification', () => {
    const browser = createBrowser()
    const Notification = browser.inject()
    const instance = new Notification('Ready', { tag: 'closed-tag' })
    const onclick = vi.fn<(event: Event) => void>()
    instance.onclick = onclick
    instance.close()

    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://notification-clicked', tag: 'closed-tag' }))

    expect(onclick).not.toHaveBeenCalled()
    expect(browser.window.dispatchEvent).toHaveBeenCalledTimes(1)
  })

  it('routes a replaced notification tag to the most recent Notification instance', () => {
    const browser = createBrowser()
    const Notification = browser.inject()
    const oldClick = vi.fn<(event: Event) => void>()
    const newClick = vi.fn<(event: Event) => void>()
    new Notification('Old', { tag: 'shared-tag' }).onclick = oldClick
    new Notification('New', { tag: 'shared-tag' }).onclick = newClick

    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://notification-clicked', tag: 'shared-tag' }))

    expect(oldClick).not.toHaveBeenCalled()
    expect(newClick).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'click' }))
  })

  it('bounds retained notification callbacks to the most recent 128 instances', () => {
    const browser = createBrowser()
    const Notification = browser.inject()
    const oldClick = vi.fn<(event: Event) => void>()
    const recentClick = vi.fn<(event: Event) => void>()
    new Notification('Old', { tag: 'tag-0' }).onclick = oldClick
    for (let index = 1; index < 128; index++) {
      const instance = new Notification('Middle', { tag: `tag-${index}` })
      expect(instance.tag).toBe(`tag-${index}`)
    }
    new Notification('Recent', { tag: 'tag-128' }).onclick = recentClick

    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://notification-clicked', tag: 'tag-0' }))
    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://notification-clicked', tag: 'tag-128' }))

    expect(oldClick).not.toHaveBeenCalled()
    expect(recentClick).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'click' }))
  })

  it('round-trips a tag-derived session through the optional official workspace service and acknowledged focus', () => {
    const browser = createBrowser()
    const Notification = browser.inject()
    const focus = vi.fn<(sessionId: string) => void>()
    const get = vi.fn().mockReturnValue({ openSession: focus })
    browser.window.__dshClientCtx = {
      get,
      get uiWorkspace(): { openSession: (sessionId: string) => void } { throw new Error('cannot get property "uiWorkspace" without inject') },
    }
    const instance = new Notification('Ready', { body: 'Done', tag: 'dsh-notification-pending-session-alpha-17' })
    const onclick = vi.fn()
    instance.onclick = onclick
    const raw = browser.posts.mock.calls[0]?.[0]
    if (raw === undefined)
      throw new Error('Tag-derived notification was not posted')
    const message = parseNativeMessage(raw, nativeUrl, origin, nonce)
    expect(message).toEqual({ type: 'dsh://native-notification', title: 'Ready', body: 'Done', tag: 'dsh-notification-pending-session-alpha-17', sessionId: 'session-alpha', silent: false })
    if (message?.type !== 'dsh://native-notification')
      throw new Error('Tag-derived notification failed native validation')

    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://focus-session', requestId: 'request-1', sessionId: message.sessionId, tag: message.tag, title: message.title }))

    expect(get).toHaveBeenCalledExactlyOnceWith('uiWorkspace')
    expect(focus).toHaveBeenCalledExactlyOnceWith('session-alpha')
    expect(onclick).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'click' }))
    expect(browser.document.querySelectorAll).not.toHaveBeenCalled()
    expect(browser.window.dispatchEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: 'message',
      source: browser.window,
      origin: 'https://harness.test:3080',
      data: { type: 'dsh://focus-session', requestId: 'request-1', sessionId: 'session-alpha', tag: 'dsh-notification-pending-session-alpha-17', title: 'Ready' },
    }))
    expect(parseNativeMessage(browser.posts.mock.calls[1]![0], nativeUrl, origin, nonce)).toEqual({ type: 'dsh://focus-result', requestId: 'request-1', handled: true })
  })

  it('uses the actual DSH session row key rather than an invented session attribute', () => {
    const unrelated = sessionNode({ 'data-row-key': 'workspace:session-alpha' })
    const target = sessionNode({ 'data-row-key': 'session:session-alpha' })
    const duplicate = sessionNode({ 'data-row-key': 'session:session-alpha' })
    const browser = createBrowser({ nodes: [unrelated, target, duplicate] })
    browser.inject()

    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://focus-session', requestId: 'row-request', sessionId: 'session-alpha', tag: 'tag' }))

    expect(browser.document.querySelectorAll).toHaveBeenCalledExactlyOnceWith('[data-row-key]')
    expect(unrelated.click).not.toHaveBeenCalled()
    expect(target.click).toHaveBeenCalledExactlyOnceWith()
    expect(duplicate.click).not.toHaveBeenCalled()
    expect(parseNativeMessage(browser.posts.mock.calls[0]![0], nativeUrl, origin, nonce)).toEqual({ type: 'dsh://focus-result', requestId: 'row-request', handled: true })
  })

  it('supports the verified older sessions.open contract when the optional workspace service is absent', () => {
    const browser = createBrowser()
    browser.inject()
    const open = vi.fn()
    browser.window.__dshClientCtx = { get: vi.fn().mockReturnValue(undefined), sessions: { open } }

    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://focus-session', requestId: 'old-request', sessionId: 'session-alpha', tag: 'tag' }))

    expect(open).toHaveBeenCalledExactlyOnceWith('session-alpha')
    expect(parseNativeMessage(browser.posts.mock.calls[0]![0], nativeUrl, origin, nonce)).toEqual({ type: 'dsh://focus-result', requestId: 'old-request', handled: true })
  })

  it('does not select a session for an application-level notification with an empty session identifier', () => {
    const browser = createBrowser()
    browser.inject()
    const focus = vi.fn()
    browser.window.__dshClientCtx = { uiWorkspace: { openSession: focus } }

    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://focus-session', requestId: 'app-request', sessionId: '', tag: 'app-tag' }))

    expect(focus).not.toHaveBeenCalled()
    expect(browser.document.querySelectorAll).not.toHaveBeenCalled()
    expect(parseNativeMessage(browser.posts.mock.calls[0]![0], nativeUrl, origin, nonce)).toEqual({ type: 'dsh://focus-result', requestId: 'app-request', handled: true })
  })

  it('does not invoke focus or click callbacks when a direct native message has the wrong nonce', () => {
    const browser = createBrowser()
    const focus = vi.fn<(sessionId: string) => void>()
    const onclick = vi.fn<(event: Event) => void>()
    browser.window.__dshClientCtx = { uiWorkspace: { openSession: focus } }
    const Notification = browser.inject()
    new Notification('Ready', { tag: 'protected-tag' }).onclick = onclick

    browser.window.__dshBridgeReceive?.({ type: 'dsh://focus-session', requestId: 'wrong-request', sessionId: 'session-alpha', tag: 'protected-tag', nonce: 'wrong-nonce' })
    browser.window.__dshBridgeReceive?.({ type: 'dsh://notification-clicked', tag: 'protected-tag', nonce: 'wrong-nonce' })

    expect(focus).not.toHaveBeenCalled()
    expect(onclick).not.toHaveBeenCalled()
    expect(browser.window.dispatchEvent).not.toHaveBeenCalled()
  })
})

describe('authenticated document readiness', () => {
  it('accepts only the explicitly whitelisted readiness payload after the usual origin and nonce checks', () => {
    expect(parseNativeMessage(envelope({ type: 'dsh://bridge-ready', ignored: 'extra' }), nativeUrl, origin, nonce)).toEqual({ type: 'dsh://bridge-ready' })
    expect(parseNativeMessage(envelope({ type: 'dsh://bridge-ready' }), 'about:blank', origin, nonce)).toBeNull()
    expect(parseNativeMessage(envelope({ type: 'dsh://bridge-ready' }), nativeUrl, origin, 'other-nonce')).toBeNull()
  })

  it('does not declare an Android error document or arbitrary HTML successful just because it is complete', () => {
    const browser = createBrowser()
    browser.inject()
    browser.window.dispatchEvent(new Event('load'))

    expect(browser.posts).not.toHaveBeenCalled()
  })

  it.each(['boot', 'context', 'login'] as const)('recognizes a completed verified %s document and sends readiness only once', (kind) => {
    const browser = createBrowser({ login: kind === 'login' })
    if (kind === 'boot')
      browser.window.__DSH_BOOT__ = {}
    if (kind === 'context')
      browser.window.__dshClientCtx = {}
    browser.inject()
    browser.inject()

    const expected: Array<{ type: string, theme?: string }> = [{ type: 'dsh://bridge-ready' }]
    if (kind !== 'login')
      expected.push({ type: 'dsh://theme-state', theme: 'light' })
    expect(browser.posts.mock.calls.map(([raw]) => parseNativeMessage(raw, nativeUrl, origin, nonce))).toEqual(expected)
  })

  it('rechecks a later DSH fingerprint on same-nonce reinjection without replacing the shim or sending readiness twice', () => {
    const browser = createBrowser()
    const Notification = browser.inject()
    const listenerCount = vi.mocked(browser.window.addEventListener).mock.calls.length
    expect(browser.posts).not.toHaveBeenCalled()
    browser.window.__DSH_BOOT__ = {}

    expect(browser.inject()).toBe(Notification)
    browser.inject()

    expect(browser.posts.mock.calls.map(([raw]) => parseNativeMessage(raw, nativeUrl, origin, nonce))).toEqual([
      { type: 'dsh://bridge-ready' },
      { type: 'dsh://theme-state', theme: 'light' },
    ])
    expect(browser.window.addEventListener).toHaveBeenCalledTimes(listenerCount)
  })

  it('does not declare readiness on reinjection while the verified document is still loading', () => {
    const browser = createBrowser({ readyState: 'loading' })
    browser.inject()
    browser.window.__dshClientCtx = {}
    browser.inject()
    expect(browser.posts).not.toHaveBeenCalled()
    browser.document.readyState = 'complete'
    browser.window.dispatchEvent(new Event('load'))
    browser.inject()

    expect(browser.posts.mock.calls.map(([raw]) => parseNativeMessage(raw, nativeUrl, origin, nonce))).toEqual([
      { type: 'dsh://bridge-ready' },
      { type: 'dsh://theme-state', theme: 'light' },
    ])
  })

  it('retries readiness when the native message endpoint was absent during the first verified injection', () => {
    const browser = createBrowser()
    browser.window.__DSH_BOOT__ = {}
    browser.window.ReactNativeWebView = undefined
    const Notification = browser.inject()
    expect(browser.posts).not.toHaveBeenCalled()
    browser.window.ReactNativeWebView = { postMessage: browser.posts }

    expect(browser.inject()).toBe(Notification)
    browser.inject()

    expect(browser.posts.mock.calls.map(([raw]) => parseNativeMessage(raw, nativeUrl, origin, nonce))).toEqual([
      { type: 'dsh://bridge-ready' },
      { type: 'dsh://theme-state', theme: 'light' },
    ])
  })

  it.each(['origin', 'frame'] as const)('still rejects reinjection when the current %s is no longer trusted', (boundary) => {
    const browser = createBrowser()
    const Notification = browser.inject()
    browser.window.__DSH_BOOT__ = {}
    if (boundary === 'origin')
      browser.location.origin = 'https://foreign.test'
    else
      browser.window.top = {}

    expect(browser.run(createNotificationShim(origin, nonce))).toBe(true)

    expect(browser.window.Notification).toBe(Notification)
    expect(browser.posts).not.toHaveBeenCalled()
  })

  it('waits for document completion rather than native load-finish when injected before page content', () => {
    const browser = createBrowser({ readyState: 'loading' })
    browser.window.__DSH_BOOT__ = {}
    browser.inject()
    expect(browser.posts).not.toHaveBeenCalled()
    browser.document.readyState = 'complete'
    browser.window.dispatchEvent(new Event('load'))
    browser.window.dispatchEvent(new Event('load'))

    expect(browser.posts.mock.calls.map(([raw]) => parseNativeMessage(raw, nativeUrl, origin, nonce))).toEqual([
      { type: 'dsh://bridge-ready' },
      { type: 'dsh://theme-state', theme: 'light' },
    ])
  })
})

describe('focus acknowledgments and cold startup', () => {
  it.each([
    { type: 'dsh://focus-result', handled: true },
    { type: 'dsh://focus-result', requestId: '', handled: true },
    { type: 'dsh://focus-result', requestId: 1, handled: true },
    { type: 'dsh://focus-result', requestId: 'r'.repeat(129), handled: true },
    { type: 'dsh://focus-result', requestId: 'r' },
    { type: 'dsh://focus-result', requestId: 'r', handled: 'true' },
  ])('rejects invalid focus result metadata %j', (message) => {
    expect(parseNativeMessage(envelope(message), nativeUrl, origin, nonce)).toBeNull()
  })

  it.each([true, false])('round-trips a bounded focus result with handled=%s', (handled) => {
    const requestId = 'r'.repeat(128)
    expect(parseNativeMessage(envelope({ type: 'dsh://focus-result', requestId, handled }), nativeUrl, origin, nonce)).toEqual({ type: 'dsh://focus-result', requestId, handled })
  })

  it('retries until the real client context registers and then acknowledges exactly one selection', async () => {
    vi.useFakeTimers()
    const browser = createBrowser()
    browser.inject()
    const openSession = vi.fn()
    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://focus-session', requestId: 'cold-request', sessionId: 'session-cold', tag: 'cold-tag' }))
    await vi.advanceTimersByTimeAsync(400)
    expect(browser.posts).not.toHaveBeenCalled()
    browser.window.__dshClientCtx = { get: vi.fn().mockReturnValue({ openSession }) }
    await vi.advanceTimersByTimeAsync(200)

    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-cold')
    expect(parseNativeMessage(browser.posts.mock.calls[0]![0], nativeUrl, origin, nonce)).toEqual({ type: 'dsh://focus-result', requestId: 'cold-request', handled: true })
    await vi.advanceTimersByTimeAsync(20000)
    expect(browser.posts).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not steal focus while the page is still loading or the app is hidden', async () => {
    vi.useFakeTimers()
    const browser = createBrowser({ readyState: 'loading', hidden: true })
    browser.inject()
    const openSession = vi.fn()
    browser.window.__dshClientCtx = { uiWorkspace: { openSession } }
    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://focus-session', requestId: 'visible-request', sessionId: 'session-visible', tag: 'tag' }))
    await vi.advanceTimersByTimeAsync(200)
    browser.document.readyState = 'complete'
    await vi.advanceTimersByTimeAsync(200)
    expect(openSession).not.toHaveBeenCalled()
    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://visibility-state', hidden: false }))
    await vi.advanceTimersByTimeAsync(200)

    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-visible')
    expect(parseNativeMessage(browser.posts.mock.calls[0]![0], nativeUrl, origin, nonce)).toEqual({ type: 'dsh://focus-result', requestId: 'visible-request', handled: true })
  })

  it('returns a negative acknowledgment at the exact fifteen-second budget instead of losing a cold click', async () => {
    vi.useFakeTimers()
    const browser = createBrowser()
    browser.inject()
    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://focus-session', requestId: 'expired-request', sessionId: 'not-ready', tag: 'tag' }))
    await vi.advanceTimersByTimeAsync(14999)
    expect(browser.posts).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(parseNativeMessage(browser.posts.mock.calls[0]![0], nativeUrl, origin, nonce)).toEqual({ type: 'dsh://focus-result', requestId: 'expired-request', handled: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels superseded requests and never selects their stale session later', async () => {
    vi.useFakeTimers()
    const browser = createBrowser()
    browser.inject()
    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://focus-session', requestId: 'first', sessionId: 'session-old', tag: 'tag-old' }))
    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://focus-session', requestId: 'second', sessionId: 'session-new', tag: 'tag-new' }))
    const openSession = vi.fn()
    browser.window.__dshClientCtx = { uiWorkspace: { openSession } }
    await vi.advanceTimersByTimeAsync(200)

    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-new')
    expect(parseNativeMessage(browser.posts.mock.calls[0]![0], nativeUrl, origin, nonce)).toEqual({ type: 'dsh://focus-result', requestId: 'second', handled: true })
    expect(browser.posts).toHaveBeenCalledTimes(1)
  })

  it('only cancels the request named by the native cleanup and releases its timer', async () => {
    vi.useFakeTimers()
    const browser = createBrowser()
    browser.inject()
    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://focus-session', requestId: 'cancelled', sessionId: 'session-old', tag: 'tag' }))
    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://cancel-focus', requestId: 'other' }))
    expect(vi.getTimerCount()).toBe(1)
    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://cancel-focus', requestId: 'cancelled' }))
    expect(vi.getTimerCount()).toBe(0)
    const openSession = vi.fn()
    browser.window.__dshClientCtx = { uiWorkspace: { openSession } }
    await vi.advanceTimersByTimeAsync(20000)
    expect(openSession).not.toHaveBeenCalled()
    expect(browser.posts).not.toHaveBeenCalled()
  })

  it('releases a pending cold-focus timer when the document navigates away', () => {
    vi.useFakeTimers()
    const browser = createBrowser()
    browser.inject()
    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://focus-session', requestId: 'page-request', sessionId: 'session', tag: 'tag' }))
    expect(vi.getTimerCount()).toBe(1)
    browser.window.dispatchEvent(new Event('pagehide'))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('acknowledges retries of an already handled request without selecting or clicking twice', () => {
    const browser = createBrowser()
    const Notification = browser.inject()
    const openSession = vi.fn()
    const onclick = vi.fn()
    browser.window.__dshClientCtx = { uiWorkspace: { openSession } }
    new Notification('Ready', { tag: 'tag' }).onclick = onclick
    browser.posts.mockClear()
    const script = nativeMessageScript(origin, nonce, { type: 'dsh://focus-session', requestId: 'replayed', sessionId: 'session', tag: 'tag' })
    browser.run(script)
    browser.run(script)

    expect(openSession).toHaveBeenCalledExactlyOnceWith('session')
    expect(onclick).toHaveBeenCalledTimes(1)
    expect(browser.posts.mock.calls.map(([raw]) => parseNativeMessage(raw, nativeUrl, origin, nonce))).toEqual([
      { type: 'dsh://focus-result', requestId: 'replayed', handled: true },
      { type: 'dsh://focus-result', requestId: 'replayed', handled: true },
    ])
  })
})

describe('nativeMessageScript origin guard', () => {
  it('delivers a native payload only to the installed top-page bridge', () => {
    const browser = createBrowser()
    const receive = vi.fn<(data: Record<string, unknown>) => void>()
    browser.window.__dshBridgeNonce = nonce
    browser.window.__dshBridgeReceive = receive

    expect(browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://visibility-state', hidden: true }))).toBe(true)

    expect(receive).toHaveBeenCalledExactlyOnceWith({ type: 'dsh://visibility-state', hidden: true, nonce: 'bridge-nonce' })
  })

  it.each([
    { locationOrigin: 'https://evil.test:3080' },
    { locationOrigin: 'http://harness.test:3080' },
    { topFrame: false },
  ])('does not expose a native payload after untrusted navigation or in a subframe %j', (options) => {
    const browser = createBrowser(options)
    const receive = vi.fn<(data: Record<string, unknown>) => void>()
    browser.window.__dshBridgeNonce = nonce
    browser.window.__dshBridgeReceive = receive

    expect(browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://focus-session', sessionId: 'private-session' }))).toBe(true)

    expect(receive).not.toHaveBeenCalled()
  })

  it('rejects injection when the installed bridge nonce belongs to another WebView generation', () => {
    const browser = createBrowser()
    const receive = vi.fn<(data: Record<string, unknown>) => void>()
    browser.window.__dshBridgeNonce = 'old-bridge-nonce'
    browser.window.__dshBridgeReceive = receive

    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://focus-session', sessionId: 'private-session' }))

    expect(receive).not.toHaveBeenCalled()
  })

  it('completes safely if the page bridge receiver has not been installed', () => {
    const browser = createBrowser()
    browser.window.__dshBridgeNonce = nonce

    expect(browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://visibility-state', hidden: true }))).toBe(true)
    expect(browser.window.__dshBridgeReceive).toBeUndefined()
  })

  it('serializes quotes and control characters without executing payload text', () => {
    const browser = createBrowser()
    const receive = vi.fn<(data: Record<string, unknown>) => void>()
    browser.window.__dshBridgeNonce = nonce
    browser.window.__dshBridgeReceive = receive
    const sessionId = '\"\\\n; throw new Error(\"payload executed\"); //'

    expect(browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://focus-session', sessionId }))).toBe(true)

    expect(receive).toHaveBeenCalledExactlyOnceWith({ type: 'dsh://focus-session', sessionId: '\"\\\n; throw new Error(\"payload executed\"); //', nonce: 'bridge-nonce' })
  })

  it('does not allow payload metadata to override the authenticated native nonce', () => {
    const browser = createBrowser()
    const receive = vi.fn<(data: Record<string, unknown>) => void>()
    browser.window.__dshBridgeNonce = nonce
    browser.window.__dshBridgeReceive = receive

    browser.run(nativeMessageScript(origin, nonce, { type: 'dsh://visibility-state', hidden: true, nonce: 'forged-nonce' }))

    expect(receive).toHaveBeenCalledExactlyOnceWith({ type: 'dsh://visibility-state', hidden: true, nonce: 'bridge-nonce' })
  })
})
