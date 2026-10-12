// @vitest-environment node
import type { HostContext } from 'dsh-tauri'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PLUGIN_ID } from '../shared/constants'
import { apply } from './apply'
import { turnEndFacts } from './config/runtime'
import { handleSessionEvent } from './events/session-event'

// 路由注册只验接线：真实路由表与 HTTP 字节由 `server/index.test.ts` 覆盖。
vi.mock('./server', () => ({ server: vi.fn(() => 'routes-disposer') }))

const { server } = await import('./server')
const serverMock = vi.mocked(server)

interface Effect {
  run: (this: unknown) => unknown
  label: string
}

function scriptedCtx(): { ctx: HostContext, effects: Effect[], on: ReturnType<typeof vi.fn> } {
  const effects: Effect[] = []
  const on = vi.fn()
  const ctx = {
    on,
    effect: (run: (this: unknown) => unknown, label: string) => { effects.push({ run, label }) },
  } as unknown as HostContext
  return { ctx, effects, on }
}

beforeEach(() => {
  serverMock.mockClear()
  turnEndFacts.clear()
})

describe('notify-webhook host apply', () => {
  it('把会话事件处理器挂到 session/event 上', () => {
    const { ctx, on } = scriptedCtx()
    apply(ctx)
    expect(on).toHaveBeenCalledTimes(1)
    expect(on).toHaveBeenCalledWith('session/event', handleSessionEvent)
  })

  it('用两条具名 effect 声明路由与运行期状态，注册期不做任何事', () => {
    const { ctx, effects } = scriptedCtx()
    apply(ctx)
    expect(effects.map(effect => effect.label)).toEqual([`${PLUGIN_ID}: routes`, `${PLUGIN_ID}: host runtime`])
    expect(serverMock).not.toHaveBeenCalled()
  })

  it('路由 effect 把宿主上下文原样交给 webServer 装配', () => {
    const { ctx, effects } = scriptedCtx()
    apply(ctx)
    const dispose = effects[0]?.run.call(ctx)
    expect(serverMock).toHaveBeenCalledTimes(1)
    expect(serverMock).toHaveBeenCalledWith(ctx)
    expect(dispose).toBe('routes-disposer')
  })

  it('运行期 effect 的清理把回合结束事实清空', () => {
    const { ctx, effects } = scriptedCtx()
    apply(ctx)
    turnEndFacts.set('s1', { reason: 'aborted', turn: 3 })
    const dispose = effects[1]?.run.call(ctx) as () => void
    expect(turnEndFacts.size).toBe(1)
    dispose()
    expect(turnEndFacts.size).toBe(0)
  })
})
