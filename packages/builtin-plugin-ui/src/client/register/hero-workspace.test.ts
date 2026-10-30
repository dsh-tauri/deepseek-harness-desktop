// @vitest-environment jsdom
import type { ClientContext } from 'dsh-tauri/client'
import type { SelectorHook } from '../types/selector'
import type { SessionListStateLike } from '../ui/hero-workspace.types'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { heroWorkspaceFeature } from './hero-workspace'

const HERO_WORKSPACE_SLOT = 'conversation.hero.workspace'
const HERO_WORKSPACE_FLOW_SLOT = 'conversation.hero.workspace.directoryFlow'
const HERO_WORKSPACE_PRIORITY = -1

const mocks = vi.hoisted(() => ({
  workspaceService: {
    model: { create: vi.fn() },
    create(input: { path: string }) { return this.model.create(input) },
  },
  startUngroupedSession: vi.fn(),
  registrations: [] as Array<{ key: string, options: Record<string, unknown>, component: unknown }>,
  composerWorkspaceLess: true,
  workspaceServiceAvailable: true,
  sessions: undefined as { list: { getSnapshot: () => { current?: string }, subscribe: (listener: () => void) => () => void } } | undefined,
  sessionsService: undefined as { list: { getSnapshot: () => { current?: string }, subscribe: (listener: () => void) => () => void } } | undefined,
}))

vi.mock('../service/ungrouped-session', () => ({ startUngroupedSession: mocks.startUngroupedSession }))

vi.mock('../ui/hero-workspace', () => ({ HeroWorkspace: () => null }))

vi.mock('dsh-tauri/client', () => ({
  defineRegister: (ctxOrSetup: unknown, maybeSetup?: unknown) => {
    const setup = (typeof maybeSetup === 'function' ? maybeSetup : ctxOrSetup) as
      (controller: unknown, ctx: unknown, adapter: unknown) => void
    return function registerEffect(this: unknown) {
      const disposers: Array<() => void> = []
      const controller = {
        add: (disposer: () => void) => {
          disposers.push(disposer)
        },
        listen: () => () => {},
        observe: () => ({ disconnect: () => {} }),
        isDisposed: () => false,
        dispose: () => {
          for (const disposer of [...disposers])
            disposer()
          disposers.length = 0
        },
      }
      setup(controller, this, {
        get sessions() { return mocks.sessions },
        service: (name: string) => name === 'sessions'
          ? mocks.sessionsService
          : name === 'workspaces' && mocks.workspaceServiceAvailable
            ? mocks.workspaceService
            : undefined,
        has: () => mocks.composerWorkspaceLess,
      })
      return () => controller.dispose()
    }
  },
}))

function createCtx(options: { flowOccupied?: boolean } = {}) {
  const register = vi.fn((slotOptions: Record<string, unknown>, component: unknown) => {
    mocks.registrations.push({ key: String(slotOptions.name), options: slotOptions, component })
    return () => {}
  })
  const inject = vi.fn((_key: string, callback: () => unknown) => {
    callback()
    return () => {}
  })
  const subscribe = vi.fn(() => () => {})
  const ctx = {
    slots: {
      register,
      inject,
      entries: () => options.flowOccupied === true ? [{}] : [],
      subscribe,
    },
  } as unknown as ClientContext
  return { ctx, register, inject, subscribe }
}

afterEach(() => {
  cleanup()
  mocks.sessions = undefined
  mocks.sessionsService = undefined
  mocks.registrations.length = 0
  mocks.composerWorkspaceLess = true
  mocks.workspaceServiceAvailable = true
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('heroWorkspaceFeature', () => {
  it('注册进官方单格槽 conversation.hero.workspace', () => {
    const { ctx, inject, register } = createCtx()

    const dispose = heroWorkspaceFeature.call(ctx)

    expect(inject, '官方槽由 ui-workspace 声明，必须经 inject 等声明到位').toHaveBeenCalledWith(
      HERO_WORKSPACE_SLOT,
      expect.any(Function),
    )
    expect(register).toHaveBeenCalledTimes(1)
    expect(mocks.registrations[0]?.key, '槽位名必须逐字等于官方单格槽').toBe(HERO_WORKSPACE_SLOT)
    expect(mocks.registrations[0]?.options.priority, 'single 槽必须用更低 priority 顶掉官方条目（同 priority 会抛错）')
      .toBe(HERO_WORKSPACE_PRIORITY)
    expect(mocks.registrations[0]?.component, '注册的必须是接管组件本体').toBeTypeOf('function')
    dispose()
  })

  it('inject 工厂绑定官方建工作区服务、未分组新建动作与目录流程占用源', async () => {
    const { ctx, subscribe } = createCtx({ flowOccupied: true })

    const dispose = heroWorkspaceFeature.call(ctx)
    const injectFactory = mocks.registrations[0]?.options.inject as () => {
      createWorkspace?: (input: { path: string }) => Promise<{ workspaceId: string }>
      startUngrouped: () => void
      hooks: { directoryFlow: { getSnapshot: () => boolean, subscribe: (listener: () => void) => () => void } }
    }
    const injected = injectFactory()

    const workspace = { workspaceId: 'workspace-new' }
    mocks.workspaceService.model.create.mockResolvedValue(workspace)
    expect(injected.createWorkspace).toBeTypeOf('function')
    await expect(injected.createWorkspace!({ path: '/tmp/example' })).resolves.toBe(workspace)
    expect(mocks.workspaceService.model.create).toHaveBeenCalledWith({ path: '/tmp/example' })

    injected.startUngrouped()
    expect(mocks.startUngroupedSession).toHaveBeenCalledTimes(1)

    expect(injected.hooks.directoryFlow.getSnapshot(), '目录流程槽已占用').toBe(true)
    const listener = vi.fn()
    injected.hooks.directoryFlow.subscribe(listener)
    expect(subscribe).toHaveBeenCalledWith(HERO_WORKSPACE_FLOW_SLOT, listener)
    dispose()
  })

  it('工作区服务晚于适配层就绪时仍可创建，缺席时不暴露入口', async () => {
    const { ctx } = createCtx()
    mocks.workspaceServiceAvailable = false
    const dispose = heroWorkspaceFeature.call(ctx)
    const injectFactory = mocks.registrations[0]?.options.inject as () => {
      createWorkspace?: (input: { path: string }) => Promise<{ workspaceId: string }>
    }

    expect(injectFactory().createWorkspace).toBeUndefined()
    mocks.workspaceServiceAvailable = true
    const workspace = { workspaceId: 'workspace-late' }
    mocks.workspaceService.model.create.mockResolvedValue(workspace)
    await expect(injectFactory().createWorkspace!({ path: '/tmp/late' })).resolves.toBe(workspace)
    expect(mocks.workspaceService.model.create).toHaveBeenCalledWith({ path: '/tmp/late' })
    dispose()
  })

  it.each(['sessions', 'sessionsService'] as const)('%s 的 current 投影随列表通知更新并在卸载时清理订阅', (source) => {
    let snapshot: SessionListStateLike = { current: 'session-first' }
    const listeners = new Set<() => void>()
    const unsubscribe = vi.fn((listener: () => void) => listeners.delete(listener))
    const list = {
      getSnapshot: vi.fn(() => snapshot),
      subscribe: vi.fn((listener: () => void) => {
        listeners.add(listener)
        return () => {
          unsubscribe(listener)
        }
      }),
    }
    mocks[source] = { list }
    if (source === 'sessions') {
      mocks.sessionsService = {
        list: {
          getSnapshot: vi.fn(() => ({ current: 'wrong-fallback-session' })),
          subscribe: vi.fn(() => () => {}),
        },
      }
    }
    const { ctx } = createCtx()
    const dispose = heroWorkspaceFeature.call(ctx)
    const injectFactory = mocks.registrations[0]!.options.inject as () => {
      useSessions: SelectorHook<SessionListStateLike>
    }
    const { useSessions } = injectFactory()
    const view = renderHook(() => useSessions(state => state.current))

    expect(view.result.current, '必须读取适配层列表投影，而非 ctx 或空快照').toBe('session-first')
    expect(list.getSnapshot).toHaveBeenCalled()
    expect(listeners.size, '挂载后必须订阅真实列表源').toBe(1)
    if (source === 'sessions') {
      expect(mocks.sessionsService!.list.getSnapshot, '直接 sessions 存在时不得读服务兜底').not.toHaveBeenCalled()
      expect(mocks.sessionsService!.list.subscribe).not.toHaveBeenCalled()
    }

    act(() => {
      snapshot = { current: 'session-next' }
      for (const listener of [...listeners])
        listener()
    })
    expect(view.result.current, '列表通知必须触发 current 投影重新渲染').toBe('session-next')

    act(() => {
      snapshot = {}
      for (const listener of [...listeners])
        listener()
    })
    expect(view.result.current, '清空当前会话后不得保留旧 current').toBeUndefined()
    expect(listeners.size, '重渲染不得叠加订阅').toBe(1)

    const activeListener = [...listeners][0]!
    const cleanupCount = unsubscribe.mock.calls.length
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(cleanupCount + 1)
    expect(unsubscribe).toHaveBeenLastCalledWith(activeListener)
    expect(listeners.size, '卸载后列表不得保留订阅').toBe(0)
    dispose()
  })

  it('sessions 缺席时投影为空，服务晚到后重渲染读取 current', () => {
    const { ctx } = createCtx()
    const dispose = heroWorkspaceFeature.call(ctx)
    const injectFactory = mocks.registrations[0]!.options.inject as () => {
      useSessions: SelectorHook<SessionListStateLike>
    }
    const { useSessions } = injectFactory()
    const view = renderHook(() => useSessions(state => state.current))
    expect(view.result.current, '服务缺席时必须稳定投影空 current').toBeUndefined()

    const unsubscribe = vi.fn()
    const subscribe = vi.fn(() => unsubscribe)
    const snapshot = { current: 'session-late' }
    mocks.sessionsService = {
      list: { getSnapshot: () => snapshot, subscribe },
    }
    view.rerender()
    expect(view.result.current, '不得永久捕获创建适配层时缺席的服务').toBe('session-late')
    expect(subscribe).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('缺 composer 补丁时不接管：保留官方工作区选择器并告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.composerWorkspaceLess = false
    const { ctx, register } = createCtx()

    const dispose = heroWorkspaceFeature.call(ctx)

    expect(register, '退级第 4 级：能力缺席时不得顶掉官方条目').not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('composer.workspace-less'))
    dispose()
  })
})
