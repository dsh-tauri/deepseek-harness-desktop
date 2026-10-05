import type { ComposerSessionEventEntry, ComposerSessionSnapshot } from './composer-resume.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { store } from '../store'
import { composerResumeFeature } from './composer-resume'

const ARROW_PATH = 'M8.3125 0.980183C8.66767 1.0531'
const PLAY_FILL_PATH = 'M14.642 6.285c1.294.777 1.294 2.653 0 3.43l-9.113 5.468c-1.333.8-3.028-.16-3.029-1.715V2.532C2.5.978 4.196.018 5.53.818z'

const RESUME_LABEL = 'resumeTask'

interface ControllerStub {
  triggerObserve: () => void
  click: (event: unknown) => void
  dispose: () => void
}

const mocks = vi.hoisted(() => ({
  resumeComposer: vi.fn(async () => ({ ok: true })),
  adapter: {} as Record<string, unknown>,
  controller: undefined as unknown,
}))

vi.mock('../service/composer-resume', () => ({ resumeComposer: mocks.resumeComposer }))

vi.mock('dsh-tauri/client', () => {
  const defineLocale = (namespace: string) => ({
    NS: namespace,
    text: (key: string) => key,
    activeLocale: () => 'en',
    isEnglishLocale: () => true,
    useLocale: () => 'en',
    registerLocale: () => () => {},
  })
  const createLifecycleController = () => {
    const disposers: Array<() => void> = []
    let clickHandler: ((event: unknown) => void) | undefined
    let observerCallback: (() => void) | undefined
    return {
      add: (disposer: () => void) => {
        disposers.push(disposer)
      },
      listen: (_type: string, handler: (event: unknown) => void) => {
        clickHandler = handler
        return () => {}
      },
      observe: (_node: unknown, callback: () => void) => {
        observerCallback = callback
        return { disconnect: () => {} }
      },
      isDisposed: () => false,
      dispose: () => {
        for (const disposer of [...disposers])
          disposer()
        disposers.length = 0
      },
      triggerObserve: () => observerCallback?.(),
      click: (event: unknown) => clickHandler?.(event),
    }
  }
  const defineStore = (definition: { state?: () => Record<string, unknown>, actions?: Record<string, unknown> }) => {
    const instance: Record<string, unknown> = definition.state?.() ?? {}
    for (const [key, action] of Object.entries(definition.actions ?? {}))
      instance[key] = (action as (...args: unknown[]) => unknown).bind(instance)
    return instance
  }
  return {
    ofetch: vi.fn(),
    defineLocale,
    defineStore,
    createLifecycleController,
    defineRegister: (ctxOrSetup: unknown, maybeSetup?: unknown) => {
      const setup = (typeof maybeSetup === 'function' ? maybeSetup : ctxOrSetup) as
        (controller: unknown, ctx: unknown, adapter: unknown) => void
      return function registerEffect(this: unknown) {
        const controller = createLifecycleController()
        mocks.controller = controller
        setup(controller, this, mocks.adapter)
        return () => controller.dispose()
      }
    },
  }
})

class FakeElement {
  closest: (selector: string) => unknown = () => null
}

class FakeButtonElement extends FakeElement {}

interface FakeIcon {
  d: string | null
}

interface FakeIconElement {
  getAttribute: (name: string) => string | null
  setAttribute: (name: string, value: string) => void
}

interface FakeButton {
  disabled: boolean
  querySelector: (selector: string) => FakeIconElement | null
  getAttribute: (name: string) => string | null
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
}

interface FakeCard {
  querySelector: (selector: string) => unknown
  querySelectorAll: (selector: string) => { length: number, item: (index: number) => FakeButton | null }
}

function snapshotSource<T>(initial: T) {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: (next: T) => {
      state = next
      for (const listener of [...listeners])
        listener()
    },
    setSilently: (next: T) => {
      state = next
    },
  }
}

function turnEnd(kind: string, error?: { message?: string, code?: string, status?: number }): ComposerSessionEventEntry {
  return { type: 'event', event: { type: 'turn/end', data: { reason: { kind, ...(error === undefined ? {} : { error }) } } } }
}

function turnStart(): ComposerSessionEventEntry {
  return { type: 'event', event: { type: 'turn/start' } }
}

function createButton(options: { path: string | null, label?: string, disabled?: boolean }) {
  const attributes = new Map<string, string>()
  if (options.label !== undefined)
    attributes.set('aria-label', options.label)
  const icon: FakeIcon = { d: options.path }
  const iconElement: FakeIconElement = {
    getAttribute: (name: string) => name === 'd' ? icon.d : null,
    setAttribute: (name: string, value: string) => {
      if (name === 'd')
        icon.d = value
    },
  }
  let disabled = options.disabled ?? true
  const button: FakeButton = {
    get disabled() {
      return disabled
    },
    set disabled(value: boolean) {
      disabled = value
    },
    querySelector: (selector: string) => selector === 'svg path' ? iconElement : null,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
  }
  Object.setPrototypeOf(button, FakeButtonElement.prototype)
  return {
    button,
    icon: () => icon.d,
    label: () => attributes.get('aria-label') ?? null,
  }
}

interface HarnessOptions {
  empty?: boolean
  running?: boolean
  entries?: ComposerSessionEventEntry[]
  path?: string | null
  buttonDisabled?: boolean
}

function harness(options: HarnessOptions = {}) {
  const sessionId = 's-1'
  const primary = createButton({
    path: options.path === undefined ? ARROW_PATH : options.path,
    label: 'Send message',
    disabled: options.buttonDisabled ?? true,
  })
  const card: FakeCard = {
    querySelector: (selector: string) =>
      selector === '[data-composer-placeholder]' && (options.empty ?? true) ? {} : null,
    querySelectorAll: () => ({ length: 1, item: () => primary.button }),
  }
  const session = snapshotSource<ComposerSessionSnapshot>({
    running: options.running ?? false,
    removed: false,
    subagent: null,
  })
  const events = snapshotSource({ entries: options.entries ?? [turnEnd('aborted')] })
  const list = snapshotSource({ current: sessionId as string | undefined })

  mocks.adapter.sessions = {
    list,
    binding: (id: string) => id === sessionId ? { session, eventSource: events } : undefined,
  }

  Object.assign(globalThis, {
    document: {
      body: {},
      querySelector: (selector: string) => selector === '[data-composer-card]' ? card : null,
    },
    Element: FakeElement,
    HTMLButtonElement: FakeButtonElement,
  })

  const ctx = { locale: { subscribe: () => () => {} } }
  const register = composerResumeFeature as unknown as (this: unknown) => () => void
  const cleanup = register.call(ctx)
  const controller = mocks.controller as ControllerStub

  return {
    sessionId,
    button: primary.button,
    icon: primary.icon,
    label: primary.label,
    disabled: () => primary.button.disabled,
    setIcon: (d: string | null) => {
      ;(primary.button.querySelector('svg path') as FakeIconElement).setAttribute('d', d ?? '')
    },
    setRunning: (running: boolean) => session.publish({ running, removed: false, subagent: null }),
    setRunningSilently: (running: boolean) => session.setSilently({ running, removed: false, subagent: null }),
    setEntries: (entries: ComposerSessionEventEntry[]) => events.publish({ entries }),
    triggerObserve: () => controller.triggerObserve(),
    click: (event: unknown) => controller.click(event),
    cleanup,
  }
}

beforeEach(() => {
  mocks.resumeComposer.mockClear()
  mocks.resumeComposer.mockResolvedValue({ ok: true })
  delete mocks.adapter.sessions
  store.safeResume.clear('s-1')
})

describe('composerResumeFeature', () => {
  it('回合中断后把主按钮改写成可点的 PlayFill', () => {
    const h = harness({ entries: [turnStart(), turnEnd('aborted')] })
    expect(h.icon()).toBe(PLAY_FILL_PATH)
    expect(h.disabled()).toBe(false)
    expect(h.label()).toBe(RESUME_LABEL)
    h.cleanup()
  })

  it('同一按钮被 React 重渲染（新 path + disabled）后再次改写', () => {
    const h = harness({ entries: [turnStart(), turnEnd('aborted')] })
    expect(h.icon()).toBe(PLAY_FILL_PATH)

    h.setIcon(ARROW_PATH)
    h.button.disabled = true
    h.triggerObserve()

    expect(h.icon()).toBe(PLAY_FILL_PATH)
    expect(h.disabled()).toBe(false)
    h.cleanup()
  })

  it('二次中断：running 尚未发布给订阅者时也能判定可继续', () => {
    const h = harness({ running: true, entries: [turnStart()] })
    expect(h.icon()).toBe(ARROW_PATH)

    h.setEntries([turnStart(), turnEnd('aborted')])
    expect(h.icon()).toBe(ARROW_PATH)

    h.setRunningSilently(false)
    h.button.disabled = true
    h.triggerObserve()

    expect(h.icon()).toBe(PLAY_FILL_PATH)
    expect(h.disabled()).toBe(false)
    h.cleanup()
  })

  it('任务进行中不改写（stop 方块阶段不被接管）', () => {
    const h = harness({ running: true, path: null, entries: [turnStart()] })
    expect(h.icon()).toBe(null)
    h.cleanup()
  })

  it('任务正常结束时不改写', () => {
    const h = harness({ entries: [turnStart(), turnEnd('completed')] })
    expect(h.icon()).toBe(ARROW_PATH)
    expect(h.disabled()).toBe(true)
    h.cleanup()
  })

  it('草稿非空时还原内核图标与禁用态', () => {
    const h = harness({ empty: false, entries: [turnStart(), turnEnd('aborted')] })
    expect(h.icon()).toBe(ARROW_PATH)
    expect(h.disabled()).toBe(true)
    h.cleanup()
  })

  it('内容审核拒绝时不改写主按钮，并把拒绝状态交给安全恢复入口', () => {
    const h = harness({
      entries: [turnStart(), turnEnd('completed'), turnStart(), turnEnd('error', { message: 'Content Exists Risk', code: 'INVALID_REQUEST', status: 400 })],
    })

    expect(h.icon()).toBe(ARROW_PATH)
    expect(h.disabled()).toBe(true)
    expect(store.safeResume.refusals['s-1']).toMatchObject({
      message: 'Content Exists Risk',
      code: 'INVALID_REQUEST',
      status: 400,
      phase: 'idle',
    })
    h.cleanup()
  })

  it('点击只请求继续，不发送草稿文本', () => {
    const h = harness({ entries: [turnStart(), turnEnd('aborted')] })
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    const target = new FakeElement()
    target.closest = () => h.button

    h.click({ target, preventDefault, stopPropagation })

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalledTimes(1)
    expect(mocks.resumeComposer).toHaveBeenCalledWith({ sessionId: 's-1' })
    h.cleanup()
  })
})
