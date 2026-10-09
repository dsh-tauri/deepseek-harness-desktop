/**
 * title.test.ts — 工作树会话显式标题生成的领域契约。
 *
 * 锁住的契约：只对登记过的（继承前缀里没有人类消息的）工作树会话补一次标题；每个会话只补一次；
 * 官方刷新缺席、抛错都只告警，绝不影响会话本身。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pendingWorktreeTitles, resetRuntime } from '../config/runtime'
import { server } from '../server'
import { worktreeTitle } from './title'

const disposers: Array<() => void> = []

function disposeServers(): void {
  for (const dispose of disposers.splice(0))
    dispose()
}

interface SetupOptions {
  refresh?: (session: unknown) => Promise<unknown>
  warn?: (message: string) => void
  withService?: boolean
}

function setup(options: SetupOptions = {}): { refresh: ReturnType<typeof vi.fn> } {
  const refresh = vi.fn(options.refresh ?? (async () => {}))
  disposers.push(server({
    get: (name: string) => (name === 'sessionTitle' && options.withService !== false ? { refresh } : undefined),
    logger: { warn: options.warn ?? (() => {}) },
    webServer: { register: () => () => {} },
  } as never))
  return { refresh }
}

const session = { id: 'session-target' }

afterEach(() => {
  disposeServers()
  resetRuntime()
})

describe('worktreeTitle.refresh', () => {
  it('登记的会话用官方 sessionTitle.refresh 补一次标题', async () => {
    const { refresh } = setup()
    pendingWorktreeTitles.add('session-target')

    await worktreeTitle.refresh(session)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith(session)
  })

  it('每个会话只补一次：登记被消费，后续回合不再刷新', async () => {
    const { refresh } = setup()
    pendingWorktreeTitles.add('session-target')

    await worktreeTitle.refresh(session)
    await worktreeTitle.refresh(session)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(pendingWorktreeTitles.size).toBe(0)
  })

  it('未登记的会话（继承前缀里已有对话）不动标题', async () => {
    const { refresh } = setup()

    await worktreeTitle.refresh(session)

    expect(refresh).not.toHaveBeenCalled()
  })

  it('会话身份不可读时不动标题也不抛出', async () => {
    const { refresh } = setup()
    pendingWorktreeTitles.add('session-target')

    await expect(worktreeTitle.refresh({})).resolves.toBeUndefined()
    await expect(worktreeTitle.refresh(undefined)).resolves.toBeUndefined()

    expect(refresh).not.toHaveBeenCalled()
    expect(pendingWorktreeTitles.has('session-target')).toBe(true)
  })

  it('刷新失败只告警：工作树会话本身照常使用', async () => {
    const warn = vi.fn()
    const { refresh } = setup({
      refresh: async () => {
        throw new Error('no route')
      },
      warn,
    })
    pendingWorktreeTitles.add('session-target')

    await expect(worktreeTitle.refresh(session)).resolves.toBeUndefined()

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session-target'))
  })

  it('部署没挂 sessionTitle 时静默跳过', async () => {
    setup({ withService: false })
    pendingWorktreeTitles.add('session-target')

    await expect(worktreeTitle.refresh(session)).resolves.toBeUndefined()
    expect(pendingWorktreeTitles.size).toBe(0)
  })

  it('宿主实例缺席时静默返回，不抛出', async () => {
    disposeServers()
    resetRuntime()
    pendingWorktreeTitles.add('session-target')

    await expect(worktreeTitle.refresh(session)).resolves.toBeUndefined()
  })
})
