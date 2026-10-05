import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { store } from '../store'
import { safeResumeFeature } from './safe-resume'

const refusal = { message: 'Content Exists Risk', code: 'INVALID_REQUEST', status: 400 }

const mocks = vi.hoisted(() => ({
  forkRefusedSession: vi.fn(async () => ({ ok: true, childId: 'child-1' })),
  adapter: {} as Record<string, unknown>,
  registrations: [] as Array<{ options: Record<string, unknown>, component: unknown }>,
}))

vi.mock('../service/safe-resume', () => ({ forkRefusedSession: mocks.forkRefusedSession }))
vi.mock('../ui/safe-resume-bar', () => ({ SafeResumeBar: () => null }))

vi.mock('dsh-tauri/client', async () => {
  const { defineStore } = await import('valtio-define')
  return {
    defineStore,
    defineRegister: (ctxOrSetup: unknown, maybeSetup?: unknown) => {
      const setup = (typeof maybeSetup === 'function' ? maybeSetup : ctxOrSetup) as
        (controller: unknown, ctx: unknown, adapter: unknown) => void
      return function registerEffect(this: unknown) {
        const controller = {
          add: () => {},
          listen: () => () => {},
          observe: () => ({ disconnect: () => {} }),
          isDisposed: () => false,
        }
        setup(controller, this, mocks.adapter)
        return () => {}
      }
    },
  }
})

function createCtx() {
  const ctx = {
    slots: {
      register: (slotOptions: Record<string, unknown>, component: unknown) => {
        mocks.registrations.push({ options: slotOptions, component })
        return () => {}
      },
      inject: (_key: string, callback: () => unknown) => {
        callback()
        return () => {}
      },
    },
  }
  return ctx
}

function install(entries: unknown[], overrides: Record<string, unknown> = {}) {
  mocks.adapter.sessions = {
    fork: vi.fn(async () => 'child-1'),
    open: vi.fn(),
    binding: () => ({ eventSource: { getSnapshot: () => ({ entries }) } }),
    ...overrides,
  }
}

function registeredOptions() {
  return mocks.registrations[0]?.options as { inject: (sessionId?: string) => Record<string, unknown> } | undefined
}

beforeEach(() => {
  Object.assign(globalThis, { document: { body: {}, querySelector: () => null } })
  mocks.registrations.length = 0
  mocks.forkRefusedSession.mockClear()
  mocks.forkRefusedSession.mockResolvedValue({ ok: true, childId: 'child-1' })
  delete mocks.adapter.sessions
  store.safeResume.clear('s-1')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('safeResumeFeature', () => {
  it('注册进官方 dock 槽，并把会话 id 与恢复动作交给提示条', () => {
    install([])
    safeResumeFeature.call(createCtx())

    expect(mocks.registrations).toHaveLength(1)
    expect(mocks.registrations[0]?.options).toMatchObject({
      name: 'conversation.input.dock',
      id: 'dsh-tauri-ui-safe-resume',
      order: -20,
      registrant: 'dsh-tauri-ui',
    })
    const injected = registeredOptions()?.inject('s-1')
    expect(injected?.sessionId).toBe('s-1')
    expect(injected?.recover).toBeTypeOf('function')
  })

  it('恢复时按最后一个正常结束的边界分叉，并打开子会话', async () => {
    install([
      { type: 'event', event: { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } } },
      { type: 'event', event: { type: 'turn/end', seq: 9, data: { reason: { kind: 'error', error: refusal } } } },
    ])
    safeResumeFeature.call(createCtx())
    store.safeResume.capture('s-1', refusal)

    await (registeredOptions()?.inject('s-1').recover as (id: string) => Promise<void>)('s-1')

    expect(mocks.forkRefusedSession).toHaveBeenCalledWith({ sessions: mocks.adapter.sessions, sessionId: 's-1', atSeq: 4 })
    expect((mocks.adapter.sessions as { open: (id: string) => void }).open).toHaveBeenCalledWith('child-1')
    expect(store.safeResume.refusals['s-1']).toBeUndefined()
  })

  it('找不到安全边界时不猜边界、不动原会话，只标记不可恢复', async () => {
    install([{ type: 'event', event: { type: 'turn/end', seq: 9, data: { reason: { kind: 'error', error: refusal } } } }])
    safeResumeFeature.call(createCtx())
    store.safeResume.capture('s-1', refusal)

    await (registeredOptions()?.inject('s-1').recover as (id: string) => Promise<void>)('s-1')

    expect(mocks.forkRefusedSession).not.toHaveBeenCalled()
    expect(store.safeResume.refusals['s-1']?.phase).toBe('unavailable')
  })

  it('恢复动作抛错时解除进行中标记并落到失败态，后续仍可重试', async () => {
    install([{ type: 'event', event: { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } } }])
    mocks.forkRefusedSession.mockRejectedValueOnce(new Error('boom'))
    safeResumeFeature.call(createCtx())
    store.safeResume.capture('s-1', refusal)

    const recover = registeredOptions()?.inject('s-1').recover as (id: string) => Promise<void>
    await recover('s-1')
    expect(store.safeResume.refusals['s-1']?.phase).toBe('failing')

    await recover('s-1')

    expect(mocks.forkRefusedSession).toHaveBeenCalledTimes(2)
    expect((mocks.adapter.sessions as { open: (id: string) => void }).open).toHaveBeenCalledWith('child-1')
  })

  it('分叉失败时把阶段落到失败态，不打开任何会话', async () => {
    install([{ type: 'event', event: { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } } }])
    mocks.forkRefusedSession.mockResolvedValue({ ok: false, error: 'session/fork-unavailable' } as never)
    safeResumeFeature.call(createCtx())
    store.safeResume.capture('s-1', refusal)

    await (registeredOptions()?.inject('s-1').recover as (id: string) => Promise<void>)('s-1')

    expect(store.safeResume.refusals['s-1']?.phase).toBe('failing')
    expect((mocks.adapter.sessions as { open: (id: string) => void }).open).not.toHaveBeenCalled()
  })
})
