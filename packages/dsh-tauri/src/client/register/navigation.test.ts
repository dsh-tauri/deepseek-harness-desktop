/**
 * register/navigation.test.ts — 宿主「文件」菜单两条命令的回归测试。
 *
 * 锁住的契约（`src/layout/components/webview.tsx` 是发送方）：
 * `dsh://session:new` → 官方新建会话入口；`dsh://workspace:add` → 选目录 + 建工作区 +
 * 开新会话。官方能力缺席时退级为点官方按钮（DOM 路径），两边都不可用才告警。
 */
import type { ClientContext } from '../types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { navigationFeature } from './navigation'

// 协议字面量按宿主侧 `src/layout/components/webview.tsx` 逐字写死。
const CMD_NEW_SESSION = 'dsh://session:new'
const CMD_ADD_WORKSPACE = 'dsh://workspace:add'

/** 父窗口桥假实现：只保留 dispatch（宿主 → iframe 命令）。 */
function stubHost(): { post: ReturnType<typeof vi.fn>, dispatch: (data: unknown) => void } {
  const listeners = new Set<(event: MessageEvent) => void>()
  const parent = { postMessage: vi.fn() }
  vi.stubGlobal('window', {
    parent,
    addEventListener: (_type: string, handler: (event: MessageEvent) => void) => listeners.add(handler),
    removeEventListener: (_type: string, handler: (event: MessageEvent) => void) => listeners.delete(handler),
  })
  return {
    post: parent.postMessage,
    dispatch: (data) => {
      for (const handler of [...listeners])
        handler({ source: parent, data } as unknown as MessageEvent)
    },
  }
}

/** ctx 只暴露适配层要探测的服务名（`readService` 优先走 ctx.get）。 */
function ctxWithServices(services: Record<string, unknown>): ClientContext {
  return { get: (name: string) => services[name] } as unknown as ClientContext
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('navigationFeature', () => {
  it('waits for the existing target, opens it once and acknowledges without creating a session', async () => {
    const host = stubHost()
    let ids: string[] = []
    let complete!: () => void
    const openSession = vi.fn(() => new Promise<void>((resolve) => {
      complete = resolve
    }))
    const startSession = vi.fn()
    const dispose = navigationFeature.call(ctxWithServices({
      sessions: { list: { getSnapshot: () => ({ ids }), subscribe: vi.fn() } },
      uiWorkspace: { openSession, startSession },
    }))
    host.dispatch({ type: 'dsh://session:open', sessionId: 'target' })
    expect(openSession).not.toHaveBeenCalled()
    ids = ['target', 'current']
    host.dispatch({ type: 'dsh://session:open', sessionId: 'target' })
    host.dispatch({ type: 'dsh://session:open', sessionId: 'target' })
    expect(host.post).not.toHaveBeenCalled()
    complete()
    await vi.waitFor(() => expect(host.post).toHaveBeenCalledExactlyOnceWith({ type: 'dsh://session:opened', sessionId: 'target' }, '*'))
    host.dispatch({ type: 'dsh://session:open', sessionId: 'target' })
    expect(host.post.mock.calls).toEqual([
      [{ type: 'dsh://session:opened', sessionId: 'target' }, '*'],
      [{ type: 'dsh://session:opened', sessionId: 'target' }, '*'],
    ])
    expect(openSession.mock.calls).toEqual([['target']])
    expect(startSession).not.toHaveBeenCalled()
    dispose()
  })

  it('reports a failed open and allows retrying the same session', async () => {
    const host = stubHost()
    const openSession = vi.fn().mockRejectedValueOnce(new Error('load failed')).mockResolvedValue(undefined)
    const dispose = navigationFeature.call(ctxWithServices({
      sessions: { list: { getSnapshot: () => ({ ids: ['target'] }), subscribe: vi.fn() } },
      uiWorkspace: { openSession },
    }))
    host.dispatch({ type: 'dsh://session:open', sessionId: 'target' })
    await vi.waitFor(() => expect(host.post).toHaveBeenCalledWith({ type: 'dsh://session:opened', sessionId: 'target', error: 'Error: load failed' }, '*'))
    host.dispatch({ type: 'dsh://session:open', sessionId: 'target' })
    await vi.waitFor(() => expect(openSession).toHaveBeenCalledTimes(2))
    dispose()
  })

  it('dsh://session:new 走官方 startSession，其它 type 不触发', async () => {
    const startSession = vi.fn()
    const host = stubHost()
    const ctx = ctxWithServices({ workspaces: { startSession } })

    const dispose = navigationFeature.call(ctx)
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
    const ctx = ctxWithServices({ workspaces: { startSession, pickDirectory, create } })

    const dispose = navigationFeature.call(ctx)
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
    const ctx = ctxWithServices({})

    const dispose = navigationFeature.call(ctx)
    host.dispatch({ type: CMD_NEW_SESSION })
    host.dispatch({ type: CMD_ADD_WORKSPACE })

    await vi.waitFor(() => expect(clicked).toHaveLength(2))
    expect(clicked[0]).toContain('新建会话')
    expect(clicked[1]).toContain('添加工作区')
    dispose()
  })
})
