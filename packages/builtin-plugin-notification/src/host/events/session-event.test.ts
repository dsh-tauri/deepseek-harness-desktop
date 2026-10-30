import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { server } from '../server'
import { clearTurnEndFacts, turnEndFact } from '../service/turn-end'
import { handleSessionEvent } from './session-event'

describe('handleSessionEvent', () => {
  let disposeServer: () => void
  beforeEach(() => {
    clearTurnEndFacts()
    disposeServer = server({
      workspaceRegistry: { archivedSessionIds: [] },
      webServer: { register: () => () => {} },
    } as unknown as Context)
  })

  afterEach(() => {
    disposeServer()
    clearTurnEndFacts()
  })

  it('记下 turn/end 的结束原因与回合号', () => {
    handleSessionEvent({ id: 's1' }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted' } } })
    expect(turnEndFact('s1')).toEqual({ reason: 'aborted', turn: 3 })
  })

  it('忽略其它事件类型', () => {
    handleSessionEvent({ id: 's1' }, { type: 'turn/start', data: { turn: 4, reason: { kind: 'aborted' } } })
    expect(turnEndFact('s1')).toBeUndefined()
  })

  it('缺少会话 id 时不记录', () => {
    handleSessionEvent({}, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    handleSessionEvent({ id: '' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    expect(turnEndFact('s1')).toBeUndefined()
  })

  it('宿主没给结束原因时记成空原因，把上一次的旧原因冲掉', () => {
    // 直接返回会留下旧的 `aborted`，客户端就会把这一回合的通知也当成中断吞掉。
    handleSessionEvent({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
    expect(turnEndFact('s1')).toEqual({ reason: 'aborted', turn: 1 })
    handleSessionEvent({ id: 's1' }, { type: 'turn/end', data: { turn: 2 } })
    expect(turnEndFact('s1')).toEqual({ reason: '', turn: 2 })
    handleSessionEvent({ id: 's1' }, { type: 'turn/end' })
    expect(turnEndFact('s1')).toEqual({ reason: '', turn: -1 })
  })

  it('宿主没给回合号时用 -1 占位', () => {
    handleSessionEvent({ id: 's2' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(turnEndFact('s2')).toEqual({ reason: 'completed', turn: -1 })
  })

  it('同一会话只保留最近一次结束事实', () => {
    handleSessionEvent({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    handleSessionEvent({ id: 's1' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } })
    expect(turnEndFact('s1')).toEqual({ reason: 'aborted', turn: 2 })
  })
})
