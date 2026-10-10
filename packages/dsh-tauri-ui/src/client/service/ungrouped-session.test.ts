/**
 * service/ungrouped-session.test.ts — 「未分组」新建会话的领域契约回归测试。
 *
 * 锁住的契约：`sessions.create()` 必须**不带** workspaceId、只带宿主解析出的未分组目录
 * （宿主才会走该 cwd 且不 attach 任何工作区，侧边栏据此把它归入「未分组」，而不是把会话
 * 落进桌面壳进程的 cwd——核心安装目录）；当前会话已是「未分组目录下的空白会话」时复用而
 * 不新造；目录解析失败时退回无参创建；失败只告警，不把 rejection 漏给 UI 调用点。
 */
import type { ClientContext, SessionId } from 'dsh-tauri/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getUngrouped } from '../apis'
import { startUngroupedSession } from './ungrouped-session'

const UNGROUPED: SessionId = 'session-ungrouped' as SessionId
const GROUPED: SessionId = 'session-grouped' as SessionId
const UNGROUPED_CWD = 'C:\\Users\\test\\.dsh\\ungrouped'
const OTHER_CWD = 'C:\\Users\\test\\AppData\\Roaming\\dsh-tauri\\dependencies\\dsh'

vi.mock('../apis', () => ({
  getUngrouped: vi.fn(async () => ({ cwd: UNGROUPED_CWD })),
}))

interface CtxOptions {
  current?: SessionId
  blank?: boolean
  cwd?: string
  sessionIds?: readonly SessionId[]
  workspacesAvailable?: boolean
  workspacesThrows?: boolean
  create?: () => Promise<SessionId>
}

function createCtx(options: CtxOptions = {}) {
  const create = vi.fn(options.create ?? (async () => 'session-new' as SessionId))
  const open = vi.fn()
  const selectPanel = vi.fn()
  const items = options.sessionIds === undefined ? [] : [{ sessionIds: options.sessionIds }]
  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => ({
          current: options.current,
          byId: options.current === undefined
            ? {}
            : { [options.current]: { blank: options.blank ?? true, cwd: options.cwd ?? UNGROUPED_CWD } },
        }),
      },
      create,
      open,
    },
    layout: { selectPanel },
    get: (name: string) => {
      if (name !== 'workspaces' || options.workspacesAvailable === false)
        return undefined
      // inject-only 守卫的真实形态：未注入的服务名读属性即抛错。
      if (options.workspacesThrows === true)
        throw new Error('service "workspaces" is not injected')
      return { list: { getSnapshot: () => ({ items }) } }
    },
  } as unknown as ClientContext
  return { ctx, create, open, selectPanel }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(getUngrouped).mockImplementation(async () => ({ cwd: UNGROUPED_CWD }))
})

describe('startUngroupedSession', () => {
  it('没有当前会话时新建：只带未分组目录，不带 workspaceId', async () => {
    const { ctx, create, open, selectPanel } = createCtx()

    startUngroupedSession(ctx)

    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('session-new'))
    expect(create, '必须落到 $DSH_HOME/ungrouped，而不是桌面壳进程的 cwd').toHaveBeenCalledWith({ cwd: UNGROUPED_CWD })
    expect(selectPanel, '必须退出面板，落到会话视图').toHaveBeenCalledWith(null)
  })

  it('当前会话已是「未分组目录下的空白会话」时复用，不再新造', async () => {
    const { ctx, create, open } = createCtx({ current: UNGROUPED, blank: true })

    startUngroupedSession(ctx)

    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(UNGROUPED))
    expect(create).not.toHaveBeenCalled()
  })

  it('当前空白会话的 cwd 是核心安装目录（历史遗留）时另起一条，不复用', async () => {
    const { ctx, create, open } = createCtx({ current: UNGROUPED, blank: true, cwd: OTHER_CWD })

    startUngroupedSession(ctx)

    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('session-new'))
    expect(create).toHaveBeenCalledWith({ cwd: UNGROUPED_CWD })
  })

  it('当前空白会话已归属某工作区时另起一条未分组会话', async () => {
    const { ctx, create, open } = createCtx({ current: GROUPED, blank: true, sessionIds: [GROUPED] })

    startUngroupedSession(ctx)

    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('session-new'))
    expect(create).toHaveBeenCalledWith({ cwd: UNGROUPED_CWD })
  })

  it('当前会话非空白时另起一条未分组会话', async () => {
    const { ctx, create } = createCtx({ current: UNGROUPED, blank: false })

    startUngroupedSession(ctx)

    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
  })

  it('工作区服务读不到时按「无法判断」处理：复用当前空白会话', async () => {
    const { ctx, create, open } = createCtx({ current: UNGROUPED, blank: true, workspacesAvailable: false })

    startUngroupedSession(ctx)

    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(UNGROUPED))
    expect(create).not.toHaveBeenCalled()
  })

  it('工作区服务读取抛错（inject-only 守卫）时同样按「无法判断」处理，不阻断开会话', async () => {
    const { ctx, create, open } = createCtx({ current: UNGROUPED, blank: true, workspacesThrows: true })

    startUngroupedSession(ctx)

    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(UNGROUPED))
    expect(create).not.toHaveBeenCalled()
  })

  it('未分组目录解析失败时退回无参创建（沿用核心默认目录），仍能开会话', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new Error('route down')
    vi.mocked(getUngrouped).mockRejectedValue(failure)
    const { ctx, create, open } = createCtx()

    startUngroupedSession(ctx)

    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('session-new'))
    expect(create).toHaveBeenCalledWith()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('未分组目录解析失败'), failure)
  })

  it('未分组目录为空串时同样退回无参创建', async () => {
    vi.mocked(getUngrouped).mockImplementation(async () => ({ cwd: '   ' }))
    const { ctx, create, open } = createCtx()

    startUngroupedSession(ctx)

    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('session-new'))
    expect(create).toHaveBeenCalledWith()
  })

  it('创建失败只告警：不打开会话、不把 rejection 漏给调用点', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new Error('boom')
    const failingCreate = async (): Promise<SessionId> => {
      throw failure
    }
    const { ctx, open, selectPanel } = createCtx({ create: failingCreate })

    startUngroupedSession(ctx)

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('未分组新建会话失败'), failure))
    expect(open).not.toHaveBeenCalled()
    expect(selectPanel).not.toHaveBeenCalled()
  })
})
