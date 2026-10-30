import type { ClientContext } from '../types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchEvent, emittedOf, listenerCount, resetTauriMock, tauriMock } from '../test-utils/tauri-mock'
import { sidebarFeature } from './sidebar'

vi.mock('../service/tauri', async () => (await import('../test-utils/tauri-mock')).tauriMock)

const CMD_TOGGLE = 'dsh://sidebar:toggle'
const EVENT_SIDEBAR_COLLAPSED = 'dsh://sidebar:collapsed'
const SIDEBAR_COLLAPSED_ATTRIBUTE = 'data-sidebar-collapsed'
const MOBILE_SIDEBAR_ATTRIBUTE = 'data-dsh-mobile-sidebar'

class FakeMutationObserver {
  static latest: FakeMutationObserver | undefined

  disconnects = 0

  constructor(readonly callback: MutationCallback) {
    FakeMutationObserver.latest = this
  }

  observe(): void {}

  disconnect(): void {
    this.disconnects++
  }

  takeRecords(): MutationRecord[] {
    return []
  }
}

function stubDocument(collapsed: boolean): { setCollapsed: (value: boolean) => void, setMobileOwned: (value: boolean) => void } {
  let state = collapsed
  let mobileOwned = false
  const frame = { hasAttribute: (name: string) => name === SIDEBAR_COLLAPSED_ATTRIBUTE && state }
  const documentElement = {
    hasAttribute: (name: string) => name === MOBILE_SIDEBAR_ATTRIBUTE && mobileOwned,
  }
  vi.stubGlobal('document', {
    body: {},
    documentElement,
    querySelector: () => ({ parentElement: frame }),
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  return {
    setCollapsed(value: boolean) {
      state = value
    },
    setMobileOwned(value: boolean) {
      mobileOwned = value
    },
  }
}

function fakeCtx(): { ctx: ClientContext, toggleSidebar: ReturnType<typeof vi.fn> } {
  const toggleSidebar = vi.fn()
  return { ctx: { layout: { toggleSidebar } } as unknown as ClientContext, toggleSidebar }
}

function collapsedReports(): boolean[] {
  return emittedOf(EVENT_SIDEBAR_COLLAPSED).map(payload => (payload as { collapsed: boolean }).collapsed)
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetTauriMock()
  FakeMutationObserver.latest = undefined
})

describe('sidebarFeature', () => {
  it('挂载即回报折叠状态，并把 toggle 命令交给布局服务', () => {
    stubDocument(true)
    vi.stubGlobal('MutationObserver', FakeMutationObserver)
    const { ctx, toggleSidebar } = fakeCtx()

    const dispose = sidebarFeature.call(ctx)

    expect(collapsedReports()).toEqual([true])

    dispatchEvent('dsh://other')
    expect(toggleSidebar).not.toHaveBeenCalled()

    dispatchEvent(CMD_TOGGLE)
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
    expect(tauriMock.invoke).not.toHaveBeenCalled()

    dispose()
  })

  it('布局服务抛错时上报插件错误，且不影响后续命令', () => {
    stubDocument(false)
    vi.stubGlobal('MutationObserver', FakeMutationObserver)
    const { ctx, toggleSidebar } = fakeCtx()
    toggleSidebar.mockImplementationOnce(() => {
      throw new Error('layout unavailable')
    })

    const dispose = sidebarFeature.call(ctx)
    dispatchEvent(CMD_TOGGLE)

    expect(tauriMock.invoke).toHaveBeenCalledTimes(1)
    const [cmd, args] = tauriMock.invoke.mock.calls[0] as [string, { id: string, error: string }]
    expect(cmd).toBe('report_plugin_error')
    expect(args.id).toBe('dsh-tauri')
    expect(args.error).toContain('layout unavailable')

    dispatchEvent(CMD_TOGGLE)
    expect(toggleSidebar).toHaveBeenCalledTimes(2)

    dispose()
  })

  it('折叠属性变化会回报一次，dispose 后停止', async () => {
    const frame = stubDocument(false)
    vi.stubGlobal('MutationObserver', FakeMutationObserver)
    const { ctx } = fakeCtx()

    const dispose = sidebarFeature.call(ctx)
    await Promise.resolve()
    expect(collapsedReports()).toEqual([false])

    frame.setCollapsed(true)
    FakeMutationObserver.latest?.callback([], FakeMutationObserver.latest as unknown as MutationObserver)
    expect(collapsedReports()).toEqual([false, true])

    dispose()
    await Promise.resolve()
    expect(listenerCount()).toBe(0)
    expect(FakeMutationObserver.latest?.disconnects).toBe(1)

    frame.setCollapsed(false)
    dispatchEvent(CMD_TOGGLE)
    expect(collapsedReports()).toEqual([false, true])
  })

  it('defers bridge ownership to the mobile drawer and resumes after handoff', () => {
    const frame = stubDocument(false)
    vi.stubGlobal('MutationObserver', FakeMutationObserver)
    const { ctx, toggleSidebar } = fakeCtx()

    const dispose = sidebarFeature.call(ctx)
    frame.setMobileOwned(true)
    dispatchEvent(CMD_TOGGLE)
    FakeMutationObserver.latest?.callback([], FakeMutationObserver.latest as unknown as MutationObserver)
    expect(toggleSidebar).not.toHaveBeenCalled()
    expect(collapsedReports()).toEqual([false])

    frame.setMobileOwned(false)
    FakeMutationObserver.latest?.callback([], FakeMutationObserver.latest as unknown as MutationObserver)
    expect(collapsedReports()).toEqual([false, false])
    dispatchEvent(CMD_TOGGLE)
    expect(toggleSidebar).toHaveBeenCalledTimes(1)

    dispose()
  })
})
