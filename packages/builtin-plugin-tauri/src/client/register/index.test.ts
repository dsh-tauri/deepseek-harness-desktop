import type { ClientAdapter } from './index'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineRegister } from './index'

class FakeMutationObserver {
  static instances: FakeMutationObserver[] = []

  readonly observed: Array<{ target: Node, options?: MutationObserverInit }> = []
  disconnects = 0

  constructor(readonly callback: MutationCallback) {
    FakeMutationObserver.instances.push(this)
  }

  observe(target: Node, options?: MutationObserverInit): void {
    this.observed.push({ target, options })
  }

  disconnect(): void {
    this.disconnects++
  }

  takeRecords(): MutationRecord[] {
    return []
  }
}

function createFakeDocument(): {
  listeners: Map<string, Set<EventListener>>
  document: Document
} {
  const listeners = new Map<string, Set<EventListener>>()
  const document = {
    addEventListener(type: string, handler: EventListener) {
      const set = listeners.get(type) ?? new Set<EventListener>()
      set.add(handler)
      listeners.set(type, set)
    },
    removeEventListener(type: string, handler: EventListener) {
      listeners.get(type)?.delete(handler)
    },
  }
  return { listeners, document: document as unknown as Document }
}

function stubDom(): Map<string, Set<EventListener>> {
  const fake = createFakeDocument()
  vi.stubGlobal('document', fake.document)
  vi.stubGlobal('MutationObserver', FakeMutationObserver)
  FakeMutationObserver.instances.length = 0
  return fake.listeners
}

function noSurvivingListener(listeners: Map<string, Set<EventListener>>): boolean {
  return [...listeners.values()].every(set => set.size === 0)
}

const target = {} as unknown as Node

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('defineRegister', () => {
  it('内部创建控制器并返回统一 disposer（幂等），setup 无需自行 dispose', () => {
    vi.useFakeTimers()
    const listeners = stubDom()
    const disposed: string[] = []

    const feature = defineRegister((controller) => {
      controller.add(() => disposed.push('listener'))
      controller.interval(() => disposed.push('tick'), 5)
      controller.listen('click', () => disposed.push('click'))
      controller.observe(target, () => disposed.push('mutate'))
    })

    const cleanup = feature()
    expect(disposed).toEqual([])
    expect(FakeMutationObserver.instances).toHaveLength(1)
    expect(listeners.get('click')?.size).toBe(1)

    cleanup()
    expect(disposed).toEqual(['listener'])
    expect(FakeMutationObserver.instances[0].disconnects).toBe(1)
    expect(noSurvivingListener(listeners)).toBe(true)

    vi.advanceTimersByTime(50)
    expect(disposed).toEqual(['listener'])

    cleanup()
    expect(disposed).toEqual(['listener'])
    expect(FakeMutationObserver.instances[0].disconnects).toBe(1)
  })

  it('单参形式从 this 取 ctx（配合 ctx.effect 的 call(ctx) 绑定）', () => {
    stubDom()
    const seen: unknown[] = []
    const ctx = { name: 'client-ctx' }

    const feature = defineRegister<typeof ctx>((_controller, received) => {
      seen.push(received)
    })

    const cleanup = feature.call(ctx)
    expect(seen).toEqual([ctx])
    cleanup()
  })

  it('this 是 cordis Fiber 时取 fiber.ctx（effect 回调的真实形态）', () => {
    stubDom()
    const seen: unknown[] = []
    const ctx = { name: 'fiber-ctx' }

    const feature = defineRegister<typeof ctx>((_controller, received) => {
      seen.push(received)
    })

    const cleanup = feature.call({ uid: 1, ctx })
    expect(seen).toEqual([ctx])
    cleanup()
  })

  it('双参形式显式传 ctx，并支持直接调用（不依赖 this）', () => {
    stubDom()
    const seen: unknown[] = []
    const ctx = { name: 'explicit-ctx' }

    const cleanup = defineRegister(ctx, (_controller, received) => {
      seen.push(received)
    })()

    expect(seen).toEqual([ctx])
    cleanup()
  })

  it('setup 抛错时回收已登记资源并向上抛', () => {
    stubDom()
    const disposed: string[] = []
    const boom = new Error('setup failed')

    const feature = defineRegister((controller) => {
      controller.add(() => disposed.push('registered-before-throw'))
      controller.observe(target, () => {})
      throw boom
    })

    expect(() => feature()).toThrowError(boom)
    expect(disposed).toEqual(['registered-before-throw'])
    expect(FakeMutationObserver.instances[0].disconnects).toBe(1)
  })

  it('setup 返回 disposer / disposer 数组时一并登记（兜底老写法）', () => {
    stubDom()
    const disposed: string[] = []

    const single = defineRegister(() => () => disposed.push('single'))()
    const multiple = defineRegister(() => [
      () => disposed.push('first'),
      () => disposed.push('second'),
    ])()

    expect(disposed).toEqual([])
    single()
    expect(disposed).toEqual(['single'])
    multiple()
    expect(disposed).toEqual(['single', 'first', 'second'])
  })

  it('observe 的 options 是第三个参数且可省略（默认子树子节点增删）', () => {
    stubDom()
    const feature = defineRegister((controller) => {
      controller.observe(target, () => {}, { attributes: true })
      controller.observe(target, () => {})
    })

    const cleanup = feature()
    const [withOptions, withDefault] = FakeMutationObserver.instances

    expect(withOptions.observed).toEqual([{ target, options: { attributes: true } }])
    expect(withDefault.observed).toEqual([{ target, options: { childList: true, subtree: true } }])

    cleanup()
  })

  it('第三个参数是 DSH 升级迁移适配器：按 ctx 探测，缺服务也不抛错', () => {
    stubDom()
    const seen: unknown[] = []
    const received: unknown[] = []
    const ctx = { name: 'client-ctx' }

    const feature = defineRegister<typeof ctx>((_controller, passedCtx, adapter) => {
      received.push(passedCtx)
      seen.push(adapter)
    })

    const cleanup = feature.call(ctx)
    expect(received).toEqual([ctx])
    expect(seen).toHaveLength(1)

    const adapter = seen[0] as ClientAdapter
    expect(adapter.generation).toBe('unknown')
    expect(adapter.migrations).toContain('services:auto-bind')
    expect(adapter.has('navigation.startSession')).toBe(false)
    expect(adapter.ctx).not.toBe(ctx)

    cleanup()
  })

  it('缺少注册回调时立即抛错', () => {
    expect(() => defineRegister(undefined as never)).toThrowError(/缺少注册回调/)
  })
})
