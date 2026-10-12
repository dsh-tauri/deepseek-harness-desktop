// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { answer, replies, resetWire, sent } from '../test-utils/client-mock'

vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

const service = await import('./delivery')

const TURN_END = '/api/tauri/notify-webhook/turn-end'

beforeEach(() => {
  resetWire()
})

describe('turnEndReason', () => {
  it('空会话 id 不发请求', async () => {
    await expect(service.turnEndReason('')).resolves.toBe('')
    expect(sent).toEqual([])
  })

  it('取回宿主记下的结束原因', async () => {
    answer(() => replies.ok({ reason: 'aborted', turn: 3 }))
    await expect(service.turnEndReason('s1')).resolves.toBe('aborted')
    expect(sent).toEqual([{ url: TURN_END, http: 'GET', body: {}, params: { sessionId: 's1' } }])
  })

  it('宿主没记录该会话时是空原因', async () => {
    answer(() => replies.ok({}))
    await expect(service.turnEndReason('ghost')).resolves.toBe('')
  })

  it('原因字段不是字符串时是空原因', async () => {
    answer(() => replies.ok({ reason: 42 }))
    await expect(service.turnEndReason('s1')).resolves.toBe('')
  })

  it('查询失败时不把异常抛给推送路径', async () => {
    answer(() => replies.http(500))
    await expect(service.turnEndReason('s1')).resolves.toBe('')
  })
})

describe('resolveTrigger', () => {
  it('把完成与查不到原因都归到完成触发器', async () => {
    for (const reason of ['completed', '', undefined]) {
      answer(() => replies.ok(reason === undefined ? {} : { reason }))
      await expect(service.resolveTrigger('s1')).resolves.toBe('completed')
    }
  })

  it('把中断、报错与超限归到异常触发器', async () => {
    for (const reason of ['aborted', 'error', 'max-tokens', 'interrupted', 'blocked']) {
      answer(() => replies.ok({ reason }))
      await expect(service.resolveTrigger('s1')).resolves.toBe('abnormal')
    }
  })
})
