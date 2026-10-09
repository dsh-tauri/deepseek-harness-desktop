// @vitest-environment jsdom
import type { PropsWithChildren } from 'react'
import type { SshMachineRow } from './use-remote'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/config/query-keys'
import { useRemote } from './use-remote'

const { invoke, windowInfo } = vi.hoisted(() => ({ invoke: vi.fn(), windowInfo: { label: 'main' } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => windowInfo }))

let client: QueryClient
let rows: SshMachineRow[]
let enabled: boolean
let listError: unknown
let eventItems: { seq: number, line: string }[]
let connect: (id: string) => Promise<{ tunnelBaseUrl: string }>
const disconnect = vi.fn(async (_id: string) => ({}))

function machineOf(partial: Partial<SshMachineRow> = {}): SshMachineRow {
  return { id: 'm1', name: 'alpha', state: 'disconnected', ...partial }
}

function Wrapper({ children }: PropsWithChildren) {
  return createElement(QueryClientProvider, { client }, children)
}

function StrictWrapper({ children }: PropsWithChildren) {
  return createElement(StrictMode, null, createElement(Wrapper, null, children))
}

function mount() {
  return renderHook(useRemote, { wrapper: Wrapper })
}

async function ready() {
  const hook = mount()
  await waitFor(() => expect(hook.result.current.enabled).toBe(true))
  return hook
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  rows = [machineOf()]
  enabled = true
  listError = undefined
  eventItems = []
  windowInfo.label = 'main'
  Object.assign(window, { __TAURI_INTERNALS__: {} })
  disconnect.mockClear()
  connect = vi.fn(async (id: string) => {
    rows = rows.map(row => row.id === id ? { ...row, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' } : row)
    return { tunnelBaseUrl: 'http://127.0.0.1:4001' }
  })
  invoke.mockReset().mockImplementation(async (command: string, args: { method: string, payload: { machineId: string, sinceSeq?: number } }) => {
    expect(command).toBe('remote')
    switch (args.method) {
      case 'GET /api/tauri/ssh/machines':
        if (listError !== undefined)
          throw listError
        return { enabled, items: rows, discovered: [] }
      case 'GET /api/tauri/ssh/machines/events':
        return { items: eventItems.filter(item => item.seq >= (args.payload.sinceSeq ?? 0)) }
      case 'POST /api/tauri/ssh/machines/connect':
        return connect(args.payload.machineId)
      case 'POST /api/tauri/ssh/machines/disconnect':
        return disconnect(args.payload.machineId)
      default:
        throw new Error(`Unexpected method: ${args.method}`)
    }
  })
})

afterEach(() => {
  cleanup()
  client.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useRemote 查询、降级与启动寻址', () => {
  it('刷新失败保留列表并降级，恢复后可用', async () => {
    const { result } = await ready()
    expect(result.current.machines.map(row => row.name)).toEqual(['alpha'])
    listError = 'REMOTE_REQUEST_FAILED: connection refused'
    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(result.current.available).toBe(false))
    expect(result.current.machines.map(row => row.name)).toEqual(['alpha'])
    listError = undefined
    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(result.current.available).toBe(true))
  })

  it.each([404, 405])('http %i 缺失 API 清空远端视图而非降级，启用后恢复', async (status) => {
    rows = [machineOf({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
    const { result } = await ready()
    act(() => result.current.switchTo('m1'))
    listError = `REMOTE_API_MISSING: ${status}`
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.available).toBe(true)
    await waitFor(() => expect(result.current.enabled).toBe(false))
    await waitFor(() => expect(result.current.machines).toEqual([]))
    expect(result.current.activeId).toBeNull()
    expect(result.current.activeTunnelUrl).toBe('')
    listError = undefined
    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(result.current.enabled).toBe(true))
    expect(result.current.machines.map(row => row.name)).toEqual(['alpha'])
  })

  it('enabled=false 清空列表和活动目标', async () => {
    rows = [machineOf({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
    const { result } = await ready()
    act(() => result.current.switchTo('m1'))
    enabled = false
    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(result.current.machines).toEqual([]))
    expect(result.current.activeId).toBeNull()
    await waitFor(() => expect(result.current.enabled).toBe(false))
  })

  it('strictMode 下 React Query 单飞并按两秒轮询，卸载停止请求', async () => {
    vi.useFakeTimers()
    const { unmount } = renderHook(useRemote, { wrapper: StrictWrapper })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    const lists = invoke.mock.calls.filter(call => call[1].method === 'GET /api/tauri/ssh/machines')
    expect(lists).toHaveLength(4)
    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(invoke.mock.calls.filter(call => call[1].method.endsWith('/machines'))).toHaveLength(4)
  })

  it('重新可见时由 React Query 刷新并恢复可用状态', async () => {
    listError = 'REMOTE_REQUEST_FAILED: connection refused'
    const { result } = mount()
    await waitFor(() => expect(result.current.available).toBe(false))
    await waitFor(() => expect(client.getQueryState(queryKeys.remoteMachines)?.fetchStatus).toBe('idle'))
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })))
    listError = undefined
    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })))
    await waitFor(() => expect(result.current.available).toBe(true))
    expect(result.current.machines.map(row => row.name)).toEqual(['alpha'])
    expect(invoke.mock.calls.filter(call => call[1].method.endsWith('/machines'))).toHaveLength(2)
  })

  it('remote-窗口已连接目标直接切换', async () => {
    windowInfo.label = 'remote-m1'
    rows = [machineOf({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
    const { result } = await ready()
    await waitFor(() => expect(result.current.activeId).toBe('m1'))
    expect(result.current.activeTunnelUrl).toBe('http://127.0.0.1:4001')
    expect(connect).not.toHaveBeenCalled()
  })

  it('remote-窗口首轮不可达，后续成功查询补切换', async () => {
    windowInfo.label = 'remote-m1'
    listError = 'REMOTE_REQUEST_FAILED: startup'
    const { result } = mount()
    await waitFor(() => expect(result.current.available).toBe(false))
    listError = undefined
    rows = [machineOf({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(result.current.activeId).toBe('m1'))
    expect(result.current.activeTunnelUrl).toBe('http://127.0.0.1:4001')
  })

  it('remote-窗口未连接目标走标准连接流程', async () => {
    windowInfo.label = 'remote-m1'
    const { result } = await ready()
    await waitFor(() => expect(result.current.activeId).toBe('m1'))
    expect(connect).toHaveBeenCalledWith('m1')
  })

  it('未知窗口目标不切换，手动选本地撤销迟到启动目标', async () => {
    windowInfo.label = 'remote-ghost'
    const { result } = await ready()
    expect(result.current.activeId).toBeNull()
    expect(connect).not.toHaveBeenCalled()
    act(() => result.current.backToLocal())
    rows = [machineOf({ id: 'ghost', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.activeId).toBeNull()
    expect(result.current.activeTunnelUrl).toBe('')
  })
})

describe('useRemote 切换和连接进度', () => {
  it('已连接目标立即切换，不调用 connect', async () => {
    rows = [machineOf({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
    const { result } = await ready()
    act(() => result.current.switchTo('m1'))
    expect(result.current.activeId).toBe('m1')
    expect(result.current.activeTunnelUrl).toBe('http://127.0.0.1:4001')
    expect(result.current.pendingId).toBeNull()
    expect(connect).not.toHaveBeenCalled()
  })

  it('未连接目标通过 mutation 连接和失效查询，就绪后切换', async () => {
    const { result } = await ready()
    act(() => result.current.switchTo('m1'))
    expect(result.current.pendingId).toBe('m1')
    expect(result.current.activeTunnelUrl).toBe('')
    await waitFor(() => expect(result.current.activeId).toBe('m1'))
    expect(connect).toHaveBeenCalledWith('m1')
    expect(result.current.activeTunnelUrl).toBe('http://127.0.0.1:4001')
    expect(result.current.pendingId).toBeNull()
  })

  it('连接失败撤销挂起，刷新引擎 given-up 状态和原始原因', async () => {
    connect = vi.fn(async () => {
      rows = [machineOf({ state: 'given-up', lastError: 'refused' })]
      throw new Error('dial tcp timeout')
    })
    const { result } = await ready()
    act(() => result.current.switchTo('m1'))
    await waitFor(() => expect(result.current.connectFailed).toEqual({ id: 'm1', error: 'dial tcp timeout' }))
    await waitFor(() => expect(result.current.machines[0].state).toBe('given-up'))
    expect(result.current.machines[0].lastError).toBe('refused')
    expect(result.current.pendingId).toBeNull()
    expect(result.current.activeId).toBeNull()
  })

  it('reconnecting 目标只挂起，轮询就绪后切换且 URL 粘性保留', async () => {
    rows = [machineOf({ state: 'reconnecting' })]
    const { result } = await ready()
    act(() => result.current.switchTo('m1'))
    expect(result.current.pendingId).toBe('m1')
    expect(connect).not.toHaveBeenCalled()
    rows = [machineOf({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(result.current.activeId).toBe('m1'))
    rows = [machineOf({ state: 'reconnecting' })]
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.activeId).toBe('m1')
    expect(result.current.activeTunnelUrl).toBe('http://127.0.0.1:4001')
  })

  it('活动机器被断开时查询自动回本地', async () => {
    rows = [machineOf({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
    const { result } = await ready()
    act(() => result.current.switchTo('m1'))
    rows = [machineOf()]
    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(result.current.activeId).toBeNull())
    expect(result.current.activeTunnelUrl).toBe('')
  })

  it('手动回本地撤销挂起，目标随后就绪不抢切', async () => {
    rows = [machineOf({ state: 'connecting' })]
    const { result } = await ready()
    act(() => result.current.switchTo('m1'))
    expect(result.current.pendingId).toBe('m1')
    act(() => result.current.backToLocal())
    rows = [machineOf({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.activeId).toBeNull()
    expect(result.current.pendingId).toBeNull()
  })

  it('降级态忽略远端切换', async () => {
    listError = 'REMOTE_REQUEST_FAILED: refused'
    const { result } = mount()
    await waitFor(() => expect(result.current.available).toBe(false))
    act(() => result.current.switchTo('m1'))
    expect(result.current.pendingId).toBeNull()
    expect(connect).not.toHaveBeenCalled()
  })

  it('断开活动机器先回本地，再下发 mutation 并刷新', async () => {
    rows = [machineOf({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
    const { result } = await ready()
    act(() => result.current.switchTo('m1'))
    disconnect.mockImplementationOnce(async () => {
      rows = [machineOf()]
      return {}
    })
    act(() => result.current.disconnect('m1'))
    expect(result.current.activeId).toBeNull()
    expect(result.current.activeTunnelUrl).toBe('')
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('m1'))
    await waitFor(() => expect(result.current.machines[0].state).toBe('disconnected'))
  })

  it('增量事件和实际阶段累积，连接成功后清空跟踪', async () => {
    let release!: (value: { tunnelBaseUrl: string }) => void
    connect = vi.fn(() => new Promise<{ tunnelBaseUrl: string }>((resolve) => {
      release = resolve
    }))
    const { result } = await ready()
    act(() => result.current.switchTo('m1'))
    await waitFor(() => expect(connect).toHaveBeenCalledWith('m1'))
    rows = [machineOf({ state: 'connecting', progress: { phase: 'installing' } })]
    eventItems = [{ seq: 0, line: 'ssh ok' }, { seq: 1, line: 'download' }]
    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(result.current.connectTrail).toEqual(['installing']))
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.remoteEvents })
    })
    await waitFor(() => expect(result.current.connectLog).toEqual(['ssh ok', 'download']))
    eventItems.push({ seq: 2, line: 'started' })
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.remoteEvents })
    })
    await waitFor(() => expect(result.current.connectLog).toEqual(['ssh ok', 'download', 'started']))
    expect(invoke).toHaveBeenCalledWith('remote', { method: 'GET /api/tauri/ssh/machines/events', payload: { machineId: 'm1', sinceSeq: 2 } })
    rows = [machineOf({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
    await act(async () => {
      release({ tunnelBaseUrl: 'http://127.0.0.1:4001' })
    })
    await waitFor(() => expect(result.current.activeId).toBe('m1'))
    expect(result.current.connectTrail).toEqual([])
    expect(result.current.connectLog).toEqual([])
  })

  it('关闭进行中弹窗不取消 mutation，失败重新显示并保留错误日志', async () => {
    let reject!: (reason: Error) => void
    connect = vi.fn(() => new Promise<{ tunnelBaseUrl: string }>((_resolve, fail) => {
      reject = fail
    }))
    const { result } = await ready()
    act(() => result.current.switchTo('m1'))
    await waitFor(() => expect(connect).toHaveBeenCalled())
    act(() => result.current.dismissConnect())
    expect(result.current.pendingId).toBe('m1')
    expect(result.current.connectDismissed).toBe(true)
    eventItems = [{ seq: 0, line: 'handshake failed' }]
    await act(async () => {
      reject(new Error('timeout'))
    })
    await waitFor(() => expect(result.current.connectFailed).toEqual({ id: 'm1', error: 'timeout' }))
    expect(result.current.connectDismissed).toBe(false)
    await waitFor(() => expect(result.current.connectLog).toEqual(['handshake failed']))
    act(() => result.current.dismissConnect())
    expect(result.current.connectFailed).toBeNull()
    expect(result.current.connectLog).toEqual([])
  })

  it.each(['success', 'failure'])('取消连接后迟到 %s 静默且不抢切换', async (outcome) => {
    let resolve!: (value: { tunnelBaseUrl: string }) => void
    let reject!: (reason: Error) => void
    connect = vi.fn(() => new Promise<{ tunnelBaseUrl: string }>((ok, fail) => {
      resolve = ok
      reject = fail
    }))
    const { result } = await ready()
    act(() => result.current.switchTo('m1'))
    await waitFor(() => expect(connect).toHaveBeenCalled())
    act(() => result.current.disconnect('m1'))
    expect(result.current.pendingId).toBeNull()
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('m1'))
    await act(async () => {
      if (outcome === 'success') {
        rows = [machineOf({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
        resolve({ tunnelBaseUrl: 'http://127.0.0.1:4001' })
      }
      else {
        reject(new Error('cancelled by disconnect'))
      }
    })
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.activeId).toBeNull()
    expect(result.current.connectFailed).toBeNull()
  })
})
