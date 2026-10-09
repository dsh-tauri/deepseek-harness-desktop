import type { HostContext, SchedulerTask } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetWriteQueue } from '../config/runtime'
import { server } from '../server'

import { loadSchedulerRuntimeModules } from '../utils/agent-runtime'
import { executor } from './executor'
import { runs } from './runs'

vi.mock('../utils/agent-runtime', () => ({
  loadSchedulerRuntimeModules: vi.fn(),
  resolveSetupAgent: vi.fn(() => ({ session: {} })),
}))

vi.mock('../utils/permission', () => ({ applyUnattendedPermission: vi.fn() }))

vi.mock('./runs', () => ({
  runs: { save: vi.fn(async () => undefined), load: vi.fn(async () => null) },
}))

const taskFixture: SchedulerTask = {
  id: 'task-1',
  name: 'nightly',
  schedule: { kind: 'interval', everyMinutes: 30, timeZone: 'UTC' },
  prompt: 'run the nightly job',
  workspaceId: 'ws-1',
  enabled: true,
  createdAt: '2025-12-31T00:00:00.000Z',
  updatedAt: '2025-12-31T00:00:00.000Z',
}

const disposers: Array<() => void> = []

interface Harness {
  cancel: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
  converge: () => void
  failConvergence: (error: unknown) => void
}

/** 首轮 `whenIdle()` 兑现（进入 followup）；次轮由 `converge()` / `failConvergence()` 决定收敛结果。 */
function installHost(): Harness {
  const cancel = vi.fn()
  const flush = vi.fn(async () => undefined)
  const session = {
    seq: 0,
    snapshotEvents: () => [{ seq: 1, type: 'turn/end', data: { reason: { kind: 'aborted' } } }],
  }
  let idleCalls = 0
  let releaseIdle: () => void = () => {}
  let rejectIdle: (error: unknown) => void = () => {}
  const idleGate = new Promise<void>((resolve, reject) => {
    releaseIdle = resolve
    rejectIdle = reject
  })
  const host = {
    loader: {},
    workspaceRegistry: { get: () => ({ path: '/tmp/ws', status: async () => 'ok' }) },
    sessions: { flush },
    agents: {
      create: async (input: { setup: (agentCtx: unknown, createdAgent: unknown) => Promise<void> }) => {
        await input.setup({}, undefined)
        return {
          agent: {
            session,
            whenIdle: () => {
              idleCalls += 1
              return idleCalls === 1 ? Promise.resolve() : idleGate
            },
            // followup 之后 seq 才增长：waitForTurnStart 立即判定「已启动」，不进入 10ms 轮询。
            followup: vi.fn(() => {
              session.seq += 1
            }),
            cancel,
          },
        }
      },
    },
  }
  disposers.push(server({ ...host, webServer: { register: () => () => {} } } as unknown as HostContext))
  return { cancel, flush, converge: releaseIdle, failConvergence: rejectIdle }
}

beforeEach(() => {
  vi.mocked(loadSchedulerRuntimeModules).mockResolvedValue({
    createUserMessage: (input: unknown) => input,
    installModelSelection: vi.fn(),
    setApprovalPolicy: vi.fn(),
  } as never)
})

afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  resetWriteQueue()
})

describe('executor.run', () => {
  it('运行超时会取消 agent，并在其收敛后按 timeout 判失败落盘', async () => {
    vi.mocked(runs.load).mockResolvedValue({ id: 'run-1' } as never)
    vi.useFakeTimers()
    try {
      const { cancel, flush, converge } = installHost()
      const pending = executor.run(taskFixture, 'schedule')

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000)

      expect(cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'scheduler run timeout' })
      expect(runs.save).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1', trigger: 'schedule', status: 'running' }))

      converge()
      const outcome = await pending

      expect(flush).toHaveBeenCalledWith(expect.objectContaining({ seq: 1 }))
      expect(outcome).toEqual({
        ok: false,
        sessionId: expect.any(String),
        error: '定时任务超过最大运行时限。',
      })
      expect(runs.save).toHaveBeenLastCalledWith(expect.objectContaining({
        status: 'failed',
        error: '定时任务超过最大运行时限。',
      }))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('取消后 agent 未能收敛时报 cancel_convergence_timeout，且不冲刷日志', async () => {
    vi.mocked(runs.load).mockResolvedValue({ id: 'run-2' } as never)
    vi.useFakeTimers()
    try {
      const { cancel, flush, failConvergence } = installHost()
      const pending = executor.run(taskFixture, 'schedule')

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
      expect(cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'scheduler run timeout' })
      expect(flush).not.toHaveBeenCalled()

      failConvergence(new Error('cancel did not converge'))
      const outcome = await pending

      expect(flush).not.toHaveBeenCalled()
      expect(outcome).toEqual({
        ok: false,
        sessionId: expect.any(String),
        error: '定时任务取消后未能在安全时限内停止。',
      })
      expect(runs.save).toHaveBeenLastCalledWith(expect.objectContaining({
        status: 'failed',
        error: '定时任务取消后未能在安全时限内停止。',
      }))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('插件卸载抛 INACTIVE_EFFECT 时记为 cancelled，不当作执行失败', async () => {
    vi.mocked(runs.load).mockResolvedValue({ id: 'run-3' } as never)
    installHost()
    vi.mocked(loadSchedulerRuntimeModules).mockRejectedValueOnce(
      Object.assign(new Error('inactive effect'), { code: 'INACTIVE_EFFECT' }),
    )

    const outcome = await executor.run(taskFixture, 'schedule')

    expect(outcome).toEqual({
      ok: false,
      sessionId: expect.any(String),
      error: '定时任务因插件卸载被取消。',
    })
    expect(runs.save).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'cancelled',
      error: '定时任务因插件卸载被取消。',
    }))
  })
})
