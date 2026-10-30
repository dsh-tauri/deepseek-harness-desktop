import type { InputActions, InputSessions, ListSessions, SwitchSessions } from './session-switch.types'
import { describe, expect, it, vi } from 'vitest'
import { openSession, switchSession, waitForInputActions, waitForSessionListed } from './session-switch'

function makeSessions(provideInfo?: InputSessions['provideInfo']): InputSessions {
  return {
    refresh: async () => {},
    list: { getSnapshot: () => ({ ids: [] }) },
    ...(provideInfo === undefined ? {} : { provideInfo }),
  }
}

function listSessions(
  snapshot: () => { ids: string[], current?: string },
  refresh: () => Promise<void> = async () => {},
): ListSessions {
  return { refresh, list: { getSnapshot: snapshot } }
}

function switchable(
  snapshot: () => { ids: string[], current?: string },
  open: (sessionId: string) => void = () => {},
  refresh: () => Promise<void> = async () => {},
): SwitchSessions {
  return { open, refresh, list: { getSnapshot: snapshot } }
}

async function wait(): Promise<void> {}

describe('waitForInputActions', () => {
  it('目标会话输入面就绪即返回', async () => {
    const actions: InputActions = { setDraft: vi.fn(), submit: vi.fn() }
    const provideInfo = vi.fn(() => ({ props: { inputActions: actions } }))

    await expect(waitForInputActions({ sessions: makeSessions(provideInfo), sessionId: 's1', wait })).resolves.toBe(actions)
    expect(provideInfo).toHaveBeenCalledWith('s1')
  })

  it('核心不提供 per-session 输入面时明确报「未就绪」，而不是 TypeError', async () => {
    await expect(waitForInputActions({ sessions: makeSessions(), sessionId: 's1', wait, attempts: 2 }))
      .rejects
      .toThrow('新工作树会话的输入服务尚未就绪')
  })

  it('输入面尚未物化时按重试次数轮询', async () => {
    const actions: InputActions = { setDraft: vi.fn(), submit: vi.fn() }
    let ready = false
    const provideInfo = vi.fn(() => (ready ? { props: { inputActions: actions } } : undefined))

    const pending = waitForInputActions({ sessions: makeSessions(provideInfo), sessionId: 's1', wait, attempts: 3 })
    ready = true

    await expect(pending).resolves.toBe(actions)
    expect(provideInfo).toHaveBeenCalledTimes(2)
  })
})

describe('waitForSessionListed', () => {
  it('目标会话已在快照中时立即返回，不刷新也不等待', async () => {
    const refresh = vi.fn(async () => {})
    const pending = vi.fn(async () => {})

    await expect(waitForSessionListed({
      sessions: listSessions(() => ({ ids: ['s1', 's2'] }), refresh),
      sessionId: 's2',
      wait: pending,
    })).resolves.toBeUndefined()

    expect(refresh).not.toHaveBeenCalled()
    expect(pending).not.toHaveBeenCalled()
  })

  it('会话后于刷新出现时按刷新次数等待，随后返回', async () => {
    let ids: string[] = []
    let refreshes = 0
    const refresh = vi.fn(async () => {
      refreshes += 1
      if (refreshes === 2)
        ids = ['s1']
    })
    const pending = vi.fn(async () => {})

    await expect(waitForSessionListed({
      sessions: listSessions(() => ({ ids }), refresh),
      sessionId: 's1',
      wait: pending,
      attempts: 5,
    })).resolves.toBeUndefined()

    expect(refresh).toHaveBeenCalledTimes(2)
    expect(pending).toHaveBeenCalledTimes(2)
  })

  it('刷新一直抛错也不会中断轮询', async () => {
    const ids: string[] = []
    const refresh = vi.fn(async () => {
      throw new Error('offline')
    })
    const pending = vi.fn(async () => {
      ids.push('s1')
    })

    await expect(waitForSessionListed({
      sessions: listSessions(() => ({ ids }), refresh),
      sessionId: 's1',
      wait: pending,
      attempts: 3,
    })).resolves.toBeUndefined()

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(pending).toHaveBeenCalledTimes(1)
  })

  it('轮询耗尽仍未被列出时抛「尚未就绪」，刷新与等待次数等于 attempts', async () => {
    const refresh = vi.fn(async () => {})
    const pending = vi.fn(async () => {})

    await expect(waitForSessionListed({
      sessions: listSessions(() => ({ ids: ['other'] }), refresh),
      sessionId: 's1',
      wait: pending,
      attempts: 3,
    })).rejects.toThrow('新工作树会话尚未就绪')

    expect(refresh).toHaveBeenCalledTimes(3)
    expect(pending).toHaveBeenCalledTimes(3)
  })

  it('未显式传 attempts 时按 SESSION_SWITCH_MAX_ATTEMPTS=30 轮询', async () => {
    const pending = vi.fn(async () => {})

    await expect(waitForSessionListed({
      sessions: listSessions(() => ({ ids: [] })),
      sessionId: 's1',
      wait: pending,
    })).rejects.toThrow('新工作树会话尚未就绪')

    expect(pending).toHaveBeenCalledTimes(30)
  })
})

describe('openSession', () => {
  it('open 后 current 指向目标时返回 true 且不再等待', async () => {
    let current = ''
    const sessions = switchable(() => ({ ids: ['s1'], current }), (sessionId: string) => {
      current = sessionId
    })
    const pending = vi.fn(async () => {})

    await expect(openSession({ sessions, sessionId: 's1', wait: pending })).resolves.toBe(true)
    expect(pending).not.toHaveBeenCalled()
  })

  it('open 抛错时刷新兜底并重试，attempts 用尽返回 false', async () => {
    const open = vi.fn(() => {
      throw new Error('not ready')
    })
    const refresh = vi.fn(async () => {})
    const pending = vi.fn(async () => {})
    const sessions = switchable(() => ({ ids: [], current: 'other' }), open, refresh)

    await expect(openSession({ sessions, sessionId: 's1', wait: pending, attempts: 3 })).resolves.toBe(false)
    expect(open).toHaveBeenCalledTimes(3)
    expect(refresh).toHaveBeenCalledTimes(3)
    expect(pending).toHaveBeenCalledTimes(3)
  })

  it('open 不抛错但 current 未切换时按轮询重试且不刷新', async () => {
    const open = vi.fn()
    const refresh = vi.fn(async () => {})
    const pending = vi.fn(async () => {})
    const sessions = switchable(() => ({ ids: ['s1'], current: 'source' }), open, refresh)

    await expect(openSession({ sessions, sessionId: 's1', wait: pending, attempts: 2 })).resolves.toBe(false)
    expect(open).toHaveBeenCalledTimes(2)
    expect(refresh).not.toHaveBeenCalled()
    expect(pending).toHaveBeenCalledTimes(2)
  })

  it('未显式传 attempts 时按 30 次重试', async () => {
    const open = vi.fn()
    const pending = vi.fn(async () => {})
    const sessions = switchable(() => ({ ids: [], current: 'other' }), open)

    await expect(openSession({ sessions, sessionId: 's1', wait: pending })).resolves.toBe(false)
    expect(open).toHaveBeenCalledTimes(30)
  })
})

describe('switchSession', () => {
  it('current 已是目标时返回 switched，不 open 不 refresh', async () => {
    const open = vi.fn()
    const refresh = vi.fn(async () => {})
    const sessions = switchable(() => ({ ids: ['s1', 's2'], current: 's2' }), open, refresh)

    await expect(switchSession({ sessions, sourceSessionId: 's1', targetSessionId: 's2' })).resolves.toBe('switched')
    expect(open).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('current 既不是源也不是目标时返回 aborted', async () => {
    const open = vi.fn()
    const sessions = switchable(() => ({ ids: ['s1', 's2'], current: 'other' }), open)

    await expect(switchSession({ sessions, sourceSessionId: 's1', targetSessionId: 's2' })).resolves.toBe('aborted')
    expect(open).not.toHaveBeenCalled()
  })

  it('目标未列出且刷新后仍未列出时返回 retry，不调用 open', async () => {
    const open = vi.fn()
    const refresh = vi.fn(async () => {})
    const sessions = switchable(() => ({ ids: ['s1'], current: 's1' }), open, refresh)

    await expect(switchSession({ sessions, sourceSessionId: 's1', targetSessionId: 's2' })).resolves.toBe('retry')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })

  it('刷新后 current 落到目标时返回 switched 且不 open', async () => {
    let current = 's1'
    let ids = ['s1']
    const open = vi.fn()
    const refresh = vi.fn(async () => {
      current = 's2'
      ids = ['s1', 's2']
    })
    const sessions = switchable(() => ({ ids, current }), open, refresh)

    await expect(switchSession({ sessions, sourceSessionId: 's1', targetSessionId: 's2' })).resolves.toBe('switched')
    expect(open).not.toHaveBeenCalled()
  })

  it('刷新后 current 离开源会话时返回 aborted', async () => {
    let current = 's1'
    let ids = ['s1']
    const refresh = vi.fn(async () => {
      current = 'other'
      ids = ['s1', 's2']
    })
    const sessions = switchable(() => ({ ids, current }), undefined, refresh)

    await expect(switchSession({ sessions, sourceSessionId: 's1', targetSessionId: 's2' })).resolves.toBe('aborted')
  })

  it('目标已列出时 open 并按切换结果返回 switched', async () => {
    let current = 's1'
    const open = vi.fn(() => {
      current = 's2'
    })
    const sessions = switchable(() => ({ ids: ['s1', 's2'], current }), open)

    await expect(switchSession({ sessions, sourceSessionId: 's1', targetSessionId: 's2' })).resolves.toBe('switched')
    expect(open).toHaveBeenCalledWith('s2')
  })

  it('open 抛错时刷新兜底，current 未切换则返回 retry', async () => {
    const open = vi.fn(() => {
      throw new Error('not ready')
    })
    const refresh = vi.fn(async () => {})
    const sessions = switchable(() => ({ ids: ['s1', 's2'], current: 's1' }), open, refresh)

    await expect(switchSession({ sessions, sourceSessionId: 's1', targetSessionId: 's2' })).resolves.toBe('retry')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('refresh 抛错时被吞掉并按快照返回 retry', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('offline')
    })
    const sessions = switchable(() => ({ ids: ['s1'], current: 's1' }), undefined, refresh)

    await expect(switchSession({ sessions, sourceSessionId: 's1', targetSessionId: 's2' })).resolves.toBe('retry')
  })
})
