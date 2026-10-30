import type { ClientContext } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchEvent, emittedOf, resetTauriMock, tauriMock } from '../test-utils/tauri-mock'
import { navigationFeature } from './navigation'

vi.mock('../service/tauri', async () => (await import('../test-utils/tauri-mock')).tauriMock)

const CMD_NEW_SESSION = 'dsh://session:new'
const CMD_ADD_WORKSPACE = 'dsh://workspace:add'
const NAVIGATION_GLOBAL = '__DSH_NAVIGATION__'

interface Host {
  window: Record<string, unknown>
  dispatch: (data: { type: string }) => void
}

function stubHost(): Host {
  const storage = new Map<string, string>()
  const host: Record<string, unknown> = {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value)
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  vi.stubGlobal('window', host)
  return {
    window: host,
    dispatch: data => dispatchEvent(data.type),
  }
}

function ctxWithServices(services: Record<string, unknown>): ClientContext {
  return { get: (name: string) => services[name] } as unknown as ClientContext
}

function stubSessions(ids: () => string[], subscribe = vi.fn()) {
  return { list: { getSnapshot: () => ({ ids: ids() }), subscribe } }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  resetTauriMock()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('navigationFeature', () => {
  it('会话列表就绪后消费一次性注入的跳转目标，并清除注入载荷', async () => {
    const host = stubHost()
    host.window[NAVIGATION_GLOBAL] = { sessionId: 'target' }
    let ids: string[] = []
    const openSession = vi.fn()

    const dispose = navigationFeature.call(ctxWithServices({
      sessions: stubSessions(() => ids),
      uiWorkspace: { openSession },
    }))

    expect(host.window[NAVIGATION_GLOBAL]).toBeUndefined()
    expect(openSession).not.toHaveBeenCalled()

    ids = ['other', 'target']
    await vi.advanceTimersByTimeAsync(500)
    expect(openSession).toHaveBeenCalledExactlyOnceWith('target')

    await vi.advanceTimersByTimeAsync(31_000)
    expect(openSession).toHaveBeenCalledOnce()
    expect(tauriMock.invoke).not.toHaveBeenCalled()
    dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('同一窗口的帧内重载不再重复打开已消费的跳转目标', async () => {
    const host = stubHost()
    host.window[NAVIGATION_GLOBAL] = { sessionId: 'target' }
    const openSession = vi.fn()
    const services = {
      sessions: stubSessions(() => ['target']),
      uiWorkspace: { openSession },
    }

    const dispose = navigationFeature.call(ctxWithServices(services))
    await vi.advanceTimersByTimeAsync(0)
    expect(openSession).toHaveBeenCalledOnce()
    dispose()

    host.window[NAVIGATION_GLOBAL] = { sessionId: 'target' }
    const reloaded = navigationFeature.call(ctxWithServices(services))
    await vi.advanceTimersByTimeAsync(31_000)
    expect(openSession).toHaveBeenCalledOnce()
    expect(tauriMock.invoke).not.toHaveBeenCalled()
    reloaded()
  })

  it('没有注入载荷时不打开任何会话', async () => {
    stubHost()
    const openSession = vi.fn()

    const dispose = navigationFeature.call(ctxWithServices({
      sessions: stubSessions(() => ['target']),
      uiWorkspace: { openSession },
    }))

    await vi.advanceTimersByTimeAsync(31_000)
    expect(openSession).not.toHaveBeenCalled()
    expect(tauriMock.invoke).not.toHaveBeenCalled()
    dispose()
  })

  it('目标会话始终缺席时上报插件错误而不是静默半工作', async () => {
    const host = stubHost()
    host.window[NAVIGATION_GLOBAL] = { sessionId: 'missing' }
    const openSession = vi.fn()

    const dispose = navigationFeature.call(ctxWithServices({
      sessions: stubSessions(() => ['target']),
      uiWorkspace: { openSession },
    }))
    await vi.advanceTimersByTimeAsync(30_000)

    expect(openSession).not.toHaveBeenCalled()
    expect(tauriMock.invoke).toHaveBeenCalledWith(
      'report_plugin_error',
      expect.objectContaining({
        error: expect.stringContaining('missing'),
        action: 'runtime',
      }),
    )
    dispose()
  })

  it('打开会话失败时上报插件错误', async () => {
    const host = stubHost()
    host.window[NAVIGATION_GLOBAL] = { sessionId: 'target' }
    const openSession = vi.fn(() => Promise.reject(new Error('load failed')))

    const dispose = navigationFeature.call(ctxWithServices({
      sessions: stubSessions(() => ['target']),
      uiWorkspace: { openSession },
    }))
    await vi.advanceTimersByTimeAsync(0)

    expect(tauriMock.invoke).toHaveBeenCalledWith(
      'report_plugin_error',
      expect.objectContaining({
        error: 'Error: load failed',
      }),
    )
    dispose()
  })

  it('dsh://session:new 走官方 startSession，其它 type 不触发', async () => {
    const host = stubHost()
    const startSession = vi.fn()
    const dispose = navigationFeature.call(ctxWithServices({ uiWorkspace: { startSession } }))

    host.dispatch({ type: 'dsh://other' })
    host.dispatch({ type: CMD_NEW_SESSION })

    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1))
    dispose()
  })

  it('dsh://workspace:add 走选目录 → 建工作区 → 在新工作区开会话', async () => {
    const startSession = vi.fn()
    const pickDirectory = vi.fn(async () => 'C:/ws')
    const create = vi.fn(async () => ({ workspaceId: 'ws-1' }))
    const host = stubHost()
    const dispose = navigationFeature.call(ctxWithServices({ workspaces: { create }, uiWorkspace: { startSession, pickDirectory } }))

    host.dispatch({ type: CMD_ADD_WORKSPACE })

    await vi.waitFor(() => expect(create).toHaveBeenCalledWith({ path: 'C:/ws' }))
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledWith('ws-1'))
    dispose()
  })

  it('官方服务缺席时退级为点官方按钮', async () => {
    const clicked: string[] = []
    vi.stubGlobal('document', {
      querySelector: (selector: string) => ({
        click: () => clicked.push(selector),
      }),
    })
    const host = stubHost()
    const dispose = navigationFeature.call(ctxWithServices({}))

    host.dispatch({ type: CMD_NEW_SESSION })
    host.dispatch({ type: CMD_ADD_WORKSPACE })

    await vi.waitFor(() => expect(clicked).toHaveLength(2))
    expect(clicked[0]).toContain('新建会话')
    expect(clicked[1]).toContain('添加工作区')
    dispose()
  })

  it('会话已消费过（刷新出的新文档）仍重新就位全屏形态，但不重复打开会话', async () => {
    const host = stubHost()
    host.window[NAVIGATION_GLOBAL] = { sessionId: 'target', presentation: 'full-sidebar' }
    const storage = host.window.sessionStorage as { setItem: (key: string, value: string) => void }
    storage.setItem('__DSH_NAVIGATION_CONSUMED__', 'target')
    const clicked: string[] = []
    const marked: string[] = []
    vi.stubGlobal('document', {
      documentElement: { hasAttribute: () => false, setAttribute: (name: string, value: string) => marked.push(`${name}=${value}`) },
      querySelector: (selector: string) => selector === '[data-sidebar-right-expand]' ? { click: () => clicked.push('expand') } : null,
    })
    let ids: string[] = []
    const openSession = vi.fn(() => ({ status: 'opened', value: Promise.resolve() }))

    const dispose = navigationFeature.call(ctxWithServices({
      sessions: stubSessions(() => ids),
      uiWorkspace: { openSession },
    }))

    ids = ['target']
    await vi.advanceTimersByTimeAsync(500)
    expect(openSession).not.toHaveBeenCalled()
    expect(marked).toContain('data-dsh-tauri-full-sidebar=presenting')
    expect(clicked).toEqual(['expand'])
    dispose()
  })

  it('带 presentation=full-sidebar 的跳转在打开会话后展开右列并切入全屏', async () => {
    const host = stubHost()
    host.window[NAVIGATION_GLOBAL] = { sessionId: 'target', presentation: 'full-sidebar' }
    const clicked: string[] = []
    const marked: string[] = []
    let mode: { getAttribute: (name: string) => string | null, click: () => void } | undefined
    const expand = { click: () => clicked.push('expand') }
    vi.stubGlobal('document', {
      documentElement: { hasAttribute: () => false, setAttribute: (name: string, value: string) => marked.push(`${name}=${value}`) },
      querySelector: (selector: string) => {
        if (selector === '[data-sidebar-right-mode]')
          return mode ?? null
        return selector === '[data-sidebar-right-expand]' ? expand : null
      },
    })
    let ids: string[] = []
    const openSession = vi.fn(() => ({ status: 'opened', value: Promise.resolve() }))

    const dispose = navigationFeature.call(ctxWithServices({
      sessions: stubSessions(() => ids),
      uiWorkspace: { openSession },
    }))

    ids = ['target']
    await vi.advanceTimersByTimeAsync(500)
    expect(openSession).toHaveBeenCalledExactlyOnceWith('target')
    expect(marked).toContain('data-dsh-tauri-full-sidebar=presenting')

    await vi.advanceTimersByTimeAsync(250)
    expect(clicked).toEqual(['expand'])

    let fullscreen = 'fullscreen'
    mode = {
      getAttribute: () => fullscreen,
      click: () => {
        clicked.push('mode')
        fullscreen = 'push'
      },
    }
    await vi.advanceTimersByTimeAsync(500)
    expect(clicked).toEqual(['expand', 'mode'])
    expect(marked.at(-1)).toBe('data-dsh-tauri-full-sidebar=ready')

    await vi.advanceTimersByTimeAsync(31_000)
    expect(clicked).toEqual(['expand', 'mode'])
    dispose()
  })

  it('会话被归档后关掉全屏窗口，而不是让它退回会话列表', () => {
    const host = stubHost()
    host.window[NAVIGATION_GLOBAL] = { sessionId: 'target', presentation: 'full-sidebar' }
    vi.stubGlobal('document', {
      documentElement: { hasAttribute: () => false, setAttribute: () => {} },
    })
    const sources: FakeEventSource[] = []
    vi.stubGlobal('EventSource', class extends FakeEventSource {
      constructor(url: string) {
        super(url)
        sources.push(this)
      }
    })
    const dispose = navigationFeature.call(ctxWithServices({
      sessions: stubSessions(() => ['target']),
    }))

    const closes = () => emittedOf('dsh://window:close')
    expect(sources).toHaveLength(1)
    expect(sources[0]?.url).toBe('/api/tauri/desktop/archive/events')
    expect(closes()).toHaveLength(0)

    sources[0]?.emit(JSON.stringify({ archivedSessionIds: ['other'] }))
    expect(closes()).toHaveLength(0)

    sources[0]?.emit(JSON.stringify({ archivedSessionIds: ['other', 'target'] }))
    expect(closes()).toHaveLength(1)
    expect(sources[0]?.closed).toBe(true)

    sources[0]?.emit(JSON.stringify({ archivedSessionIds: ['target'] }))
    expect(closes()).toHaveLength(1)
    dispose()
  })
})

class FakeEventSource {
  closed = false
  private readonly listeners: Array<(event: { data: string }) => void> = []

  constructor(readonly url: string) {}

  addEventListener(_type: string, listener: (event: { data: string }) => void): void {
    this.listeners.push(listener)
  }

  close(): void {
    this.closed = true
  }

  emit(data: string): void {
    for (const listener of this.listeners)
      listener({ data })
  }
}
