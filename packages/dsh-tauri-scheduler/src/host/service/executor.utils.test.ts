import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decideRunOutcome,
  describeFailure,
  isPluginUnloadError,
  summarizeCollectedRun,
  summarizeRun,
  waitForTurnStart,
  watchSessionEvents,
} from './executor.utils'

const runEvents = [
  { seq: 0, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  { seq: 1, type: 'turn/start', data: {} },
  { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'working' }] } } },
  { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
  { seq: 4, type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'llm_error', message: 'boom' } } } },
]

const failureReason = { kind: 'error', error: { code: 'llm_error', message: 'boom' } }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('decideRunOutcome', () => {
  it('超时优先判失败（即使 turn 已启动）', () => {
    expect(decideRunOutcome({ started: true, timedOut: true, reason: { kind: 'completed' } }))
      .toEqual({ status: 'failed', error: { code: 'timeout', message: '定时任务超过最大运行时限。' } })
  })

  it('turn 根本没启动才报「没有产生完整 turn」', () => {
    expect(decideRunOutcome({ started: false, timedOut: false, reason: undefined }))
      .toEqual({ status: 'failed', error: { code: 'no_turn_result', message: '本次定时任务没有产生完整 turn。' } })
  })

  it('turn 已启动但没有 turn/end 事件 → 成功（核心异常收尾不补写该事件）', () => {
    expect(decideRunOutcome({ started: true, timedOut: false, reason: undefined }))
      .toEqual({ status: 'succeeded' })
  })

  it('completed 视为成功', () => {
    expect(decideRunOutcome({ started: true, timedOut: false, reason: { kind: 'completed' } }))
      .toEqual({ status: 'succeeded' })
  })

  it('显式的非 completed 原因仍判失败', () => {
    expect(decideRunOutcome({ started: true, timedOut: false, reason: { kind: 'aborted' } }))
      .toEqual({ status: 'failed', error: { code: 'turn_aborted', message: '定时任务以 aborted 结束。' } })
    expect(decideRunOutcome({ started: true, timedOut: false, reason: { kind: 'error', error: { code: 'llm_error', message: 'boom' } } }))
      .toEqual({ status: 'failed', error: { code: 'llm_error', message: 'boom' } })
  })
})

describe('describeFailure', () => {
  it('没有 turn/end 收尾原因时归为 no_turn_result', () => {
    expect(describeFailure(undefined)).toEqual({ code: 'no_turn_result', message: '本次定时任务没有产生完整 turn。' })
  })

  it('取消 / 中断类收尾原因按 turn_<kind> 归类', () => {
    expect(describeFailure({ kind: 'aborted' })).toEqual({ code: 'turn_aborted', message: '定时任务以 aborted 结束。' })
    expect(describeFailure({ kind: 'interrupted' })).toEqual({ code: 'turn_interrupted', message: '定时任务以 interrupted 结束。' })
  })

  it('error 原因透传内核错误码与文案，缺失时回落到通用失败', () => {
    expect(describeFailure({ kind: 'error', error: { code: 'llm_error', message: 'boom' } }))
      .toEqual({ code: 'llm_error', message: 'boom' })
    expect(describeFailure({ kind: 'error' })).toEqual({ code: 'agent_error', message: '定时任务 Agent 执行失败。' })
    expect(describeFailure({ kind: 'error', error: { code: 42, message: '' } }))
      .toEqual({ code: 'agent_error', message: '' })
    expect(describeFailure({ kind: 'error', error: 'boom' })).toEqual({ code: 'agent_error', message: '定时任务 Agent 执行失败。' })
  })
})

describe('waitForTurnStart', () => {
  it('seq 已增长时立即返回 true，不分配轮询 timer', async () => {
    vi.useFakeTimers()
    await expect(waitForTurnStart({ seq: 8 }, 7, 50)).resolves.toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('等待期间 seq 增长时在下一轮询返回 true 并释放 timer', async () => {
    vi.useFakeTimers()
    const session = { seq: 7 }
    const pending = waitForTurnStart(session, 7, 50)
    await vi.advanceTimersByTimeAsync(10)
    session.seq = 8
    await vi.advanceTimersByTimeAsync(10)
    await expect(pending).resolves.toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('始终没启动时到截止时间返回 false，之前仍保持等待', async () => {
    vi.useFakeTimers()
    const pending = waitForTurnStart({ seq: 7 }, 7, 50)
    const settled = vi.fn()
    void pending.then(settled)
    await vi.advanceTimersByTimeAsync(49)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('启动窗口为 0 时不启动轮询，立即返回 false', async () => {
    vi.useFakeTimers()
    await expect(waitForTurnStart({ seq: 7 }, 7, 0)).resolves.toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('summarizeRun', () => {
  it('内核 0.1.2-rc.1 起改从 snapshotEvents 读日志，失败收尾不会被吞成成功', () => {
    const outcome = summarizeRun({ snapshotEvents: () => runEvents }, 1)
    expect(outcome).toEqual({ text: 'done', reason: failureReason })
    expect(decideRunOutcome({ started: true, timedOut: false, reason: outcome.reason }))
      .toEqual({ status: 'failed', error: { code: 'llm_error', message: 'boom' } })
  })

  it('legacy 内核的 log / events 仍作兜底', () => {
    for (const session of [{ log: runEvents }, { events: runEvents }]) {
      expect(summarizeRun(session, 1)).toEqual({ text: 'done', reason: failureReason })
    }
  })

  it('只统计 firstSeq 之后的事件', () => {
    expect(summarizeRun({ snapshotEvents: () => runEvents }, 5)).toEqual({ text: '' })
  })

  it('日志不可读时退化为「没有 turn/end」，交由 decideRunOutcome 兜底', () => {
    expect(summarizeRun({}, 0)).toEqual({ text: '' })
    expect(summarizeRun(undefined, 0)).toEqual({ text: '' })
  })
})

describe('watchSessionEvents', () => {
  const session = { seq: 1 }

  function bind(fromSeq: number): { emit: (target: unknown, event: unknown) => void, watched: ReturnType<typeof watchSessionEvents> } {
    const listeners: Array<(target: unknown, event: unknown) => void> = []
    const watched = watchSessionEvents(
      { on: (_name, listener) => {
        listeners.push(listener)
        return () => {
          listeners.length = 0
        }
      } },
      session,
      fromSeq,
    )
    return {
      emit: (target, event) => {
        for (const listener of listeners) listener(target, event)
      },
      watched,
    }
  }

  it('只收本会话、本轮之后的 turn 边界事件', () => {
    const { emit, watched } = bind(1)
    emit(session, { seq: 0, type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    emit({ seq: 1 }, { seq: 2, type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    emit(session, { seq: 2, type: 'request/header', data: {} })
    emit(session, { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'live' }] } } })
    emit(session, { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } })

    expect(watched.events).toEqual([
      { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'live' }] } } },
      { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ])
  })

  it('宿主没有 on 时退化为空增量，由快照兜底', () => {
    const watched = watchSessionEvents({}, session, 0)
    expect(watched.events).toEqual([])
    expect(() => watched.stop()).not.toThrow()
  })

  it('stop 解绑订阅', () => {
    const { emit, watched } = bind(1)
    watched.stop()
    emit(session, { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(watched.events).toEqual([])
  })
})

describe('summarizeCollectedRun', () => {
  it('增量带收尾原因时直接采信，不再整段扫历史', () => {
    const snapshot = vi.fn(() => runEvents)
    const live = [
      { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'live' }] } } },
      { seq: 4, type: 'turn/end', data: { reason: failureReason } },
    ]
    expect(summarizeCollectedRun(live, { snapshotEvents: snapshot }, 1)).toEqual({ text: 'live', reason: failureReason })
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('增量缺收尾原因（含丢掉 turn/end 只剩正文）时回退快照，失败不会被吞成成功', () => {
    for (const live of [
      [],
      [{ seq: 2, type: 'turn/start', data: {} }],
      [{ seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } }],
    ]) {
      const outcome = summarizeCollectedRun(live, { snapshotEvents: () => runEvents }, 1)
      expect(outcome).toEqual({ text: 'done', reason: failureReason })
      expect(decideRunOutcome({ started: true, timedOut: false, reason: outcome.reason }))
        .toEqual({ status: 'failed', error: { code: 'llm_error', message: 'boom' } })
    }
  })
})

describe('isPluginUnloadError', () => {
  it('只认 INACTIVE_EFFECT 错误码', () => {
    expect(isPluginUnloadError(Object.assign(new Error('inactive'), { code: 'INACTIVE_EFFECT' }))).toBe(true)
    expect(isPluginUnloadError(Object.assign(new Error('x'), { code: 'llm_error' }))).toBe(false)
    expect(isPluginUnloadError(new Error('inactive'))).toBe(false)
    expect(isPluginUnloadError(undefined)).toBe(false)
    expect(isPluginUnloadError('INACTIVE_EFFECT')).toBe(false)
  })
})
