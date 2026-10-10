import type { TaskTabSeatSpec } from './task-tab.test.harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskTab } from '../components/task-tab'
import { TaskTabTitle } from '../components/task-tab-title'
import { locale } from '../locales'
import { TaskTabBindings } from '../service/task-tab-bindings'
import { store } from '../store'
import { taskTabFeature } from './task-tab'
import { taskTabRuntime, taskTabSeats } from './task-tab.test.harness'

vi.mock('dsh-tauri/client', async () => ({
  ...await import('../../../../dsh-tauri/src/client/register'),
  ...await import('../../../../dsh-tauri/src/client/modules/valtio-define'),
  ...await import('../../../../dsh-tauri/src/client/locale'),
}))
vi.mock('../components/task-tab', () => ({ TaskTab: () => null }))
vi.mock('../components/task-tab-title', () => ({ TaskTabTitle: () => null }))

const cleanups: Array<() => void> = []

function mount(host: ReturnType<typeof taskTabRuntime>) {
  const dispose = taskTabFeature.call(host.context)
  cleanups.push(dispose)
  return dispose
}

async function request(id = 'task-1') {
  store.navigation.request({ id, sessionId: 'owner' })
  await vi.advanceTimersByTimeAsync(0)
}

function expectUnavailable(host: ReturnType<typeof taskTabRuntime>) {
  expect(host.openTab).not.toHaveBeenCalled()
  expect(store.navigation.target).toBeNull()
  expect(store.navigation.error).toBe('This core has no task sidebar. Update the core to enable it.')
}

function expectClean(host: ReturnType<typeof taskTabRuntime>) {
  expect(host.activeSeats.size).toBe(0)
  expect(host.definitions.size).toBe(0)
  expect(host.seatInjections.size).toBe(0)
  expect(host.serviceInjections.size).toBe(0)
  expect(host.mounted.listeners.size).toBe(0)
  expect(host.panelInfo.listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  store.navigation.$patch({ target: null, seq: 0, error: '' })
})

afterEach(() => {
  cleanups.splice(0).reverse().forEach(dispose => dispose())
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('taskTabFeature public definition and registration', () => {
  it('registers a keep-mounted scheduleTask definition and exact keyed body and title contributions', () => {
    const host = taskTabRuntime()
    const translate = vi.spyOn(locale, 'text')
    mount(host)

    expect(host.registry.register).toHaveBeenCalledTimes(1)
    const definition = host.registry.register.mock.calls[0]![0]
    expect(definition).toEqual({
      id: 'dsh-tauri-scheduler/task',
      kind: 'scheduleTask',
      priority: 'extension',
      keepMounted: true,
      title: expect.any(Function),
    })
    expect(definition.title()).toBe('Edit scheduled task')
    expect(translate).toHaveBeenCalledExactlyOnceWith('editDialogTitle')
    expect(host.slots.inject.mock.calls.map(([name]) => name)).toEqual([
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab.title',
    ])
    expect(host.slots.register.mock.calls.map(([entry, component]) => [entry.name, entry.key, component])).toEqual([
      ['sidebar.right.pane.tab', 'dsh-tauri-scheduler/task', TaskTab],
      ['sidebar.right.pane.tab.title', 'dsh-tauri-scheduler/task', TaskTabTitle],
    ])
    const body = host.activeSeats.get('sidebar.right.pane.tab:dsh-tauri-scheduler/task')!.entry.inject()
    const title = host.activeSeats.get('sidebar.right.pane.tab.title:dsh-tauri-scheduler/task')!.entry.inject()
    expect(body.t).toBe(locale.text)
    expect(title.t).toBe(locale.text)
    expect(body.taskBindings).toBeInstanceOf(TaskTabBindings)
    expect(title.taskBindings).toBe(body.taskBindings)
    expect(title.openHistorySession).toBe(body.openHistorySession)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('publishes the new target before the real synchronous sequence subscription handles a request', async () => {
    const host = taskTabRuntime()
    mount(host)
    store.navigation.request({ id: 'first-click', sessionId: 'owner' })
    await vi.advanceTimersByTimeAsync(0)

    expect(host.openTab).toHaveBeenCalledExactlyOnceWith('scheduleTask', { params: { id: 'first-click', sessionId: 'owner' } })
    expect(store.navigation.target).toBeNull()
    expect(store.navigation.error).toBe('')
  })

  it('supersedes a pending first action with exactly the second target rather than reopening the previous request', async () => {
    const host = taskTabRuntime()
    let resolveOpening = () => {}
    const opening = new Promise<void>((resolve) => {
      resolveOpening = resolve
    })
    host.openSession.mockReturnValueOnce(opening)
    mount(host)
    store.navigation.request({ id: 'first-pending', sessionId: 'owner' })
    await vi.advanceTimersByTimeAsync(0)
    expect(host.openTab).not.toHaveBeenCalled()
    store.navigation.request({ id: 'second-click', sessionId: 'owner' })
    await vi.advanceTimersByTimeAsync(0)
    resolveOpening()
    await vi.advanceTimersByTimeAsync(0)

    expect(host.openTab).toHaveBeenCalledExactlyOnceWith('scheduleTask', { params: { id: 'second-click', sessionId: 'owner' } })
    expect(store.navigation.target).toBeNull()
    expect(store.navigation.error).toBe('')
    expect(host.mounted.listeners.size).toBe(0)
    expect(host.panelInfo.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('opens queued requests only after both ready keyed session seats have registered', async () => {
    const host = taskTabRuntime()
    mount(host)
    await request()

    expect(host.activeSeats.size).toBe(2)
    expect(host.openTab).toHaveBeenCalledExactlyOnceWith('scheduleTask', { params: { id: 'task-1', sessionId: 'owner' } })
    expect(store.navigation.target).toBeNull()
    expect(store.navigation.error).toBe('')
  })

  it('owns the definition, both declaration waits, shared bindings, and navigation subscription through idempotent HMR disposal', async () => {
    const host = taskTabRuntime()
    const clear = vi.spyOn(TaskTabBindings.prototype, 'clear')
    const dispose = mount(host)
    dispose()
    dispose()

    expectClean(host)
    expect(host.fiberDisposals).toHaveBeenCalledTimes(1)
    expect(host.definitionDisposals).toHaveBeenCalledExactlyOnceWith('dsh-tauri-scheduler/task')
    expect(host.seatDisposals.mock.calls).toEqual([
      ['sidebar.right.pane.tab.title'],
      ['sidebar.right.pane.tab'],
    ])
    expect(host.injectionDisposals.mock.calls).toEqual([
      ['sidebar.right.pane.tab.title'],
      ['sidebar.right.pane.tab'],
    ])
    expect(clear).toHaveBeenCalledTimes(1)
    await request('after-dispose')
    expect(host.openTab).not.toHaveBeenCalled()
    expect(store.navigation.target).toEqual({ id: 'after-dispose', sessionId: 'owner' })

    const remount = mount(host)
    await vi.advanceTimersByTimeAsync(0)
    expect(host.openTab).toHaveBeenCalledExactlyOnceWith('scheduleTask', { params: { id: 'after-dispose', sessionId: 'owner' } })
    expect(host.activeSeats.size).toBe(2)
    expect(host.registry.register).toHaveBeenCalledTimes(2)
    remount()
    expectClean(host)
  })
})

describe('taskTabFeature late public services and capability probes', () => {
  it('waits for both public right-sidebar services and becomes usable when they arrive', async () => {
    const host = taskTabRuntime()
    host.provide('sidebarRight', undefined)
    host.provide('sidebarRightTabs', undefined)
    mount(host)
    expect(host.registry.register).not.toHaveBeenCalled()
    await request('before-services')
    expectUnavailable(host)

    host.provide('sidebarRight', host.sidebar)
    expect(host.registry.register).not.toHaveBeenCalled()
    host.provide('sidebarRightTabs', host.registry)
    expect(host.activeSeats.size).toBe(2)
    await request('after-services')
    expect(host.openTab).toHaveBeenCalledExactlyOnceWith('scheduleTask', { params: { id: 'after-services', sessionId: 'owner' } })
    expect(store.navigation.error).toBe('')
  })

  it('unloads and reinstalls contributions when a required service disappears and returns', async () => {
    const host = taskTabRuntime()
    mount(host)
    host.provide('sidebarRightTabs', undefined)
    expect(host.activeSeats.size).toBe(0)
    expect(host.definitions.size).toBe(0)
    expect(host.seatInjections.size).toBe(0)
    await request('while-unloaded')
    expectUnavailable(host)

    host.provide('sidebarRightTabs', host.registry)
    await request('after-reload')
    expect(host.openTab).toHaveBeenCalledExactlyOnceWith('scheduleTask', { params: { id: 'after-reload', sessionId: 'owner' } })
    expect(host.registry.register).toHaveBeenCalledTimes(2)
  })

  it('cancels a deferred service injection so arrival after plugin disposal cannot register or navigate', async () => {
    const host = taskTabRuntime()
    host.provide('sidebarRight', undefined)
    const dispose = mount(host)
    dispose()
    host.provide('sidebarRight', host.sidebar)
    await request('after-late-arrival')

    expectClean(host)
    expect(host.registry.register).not.toHaveBeenCalled()
    expect(host.slots.inject).not.toHaveBeenCalled()
    expect(host.openTab).not.toHaveBeenCalled()
    expect(store.navigation.target).toEqual({ id: 'after-late-arrival', sessionId: 'owner' })
  })

  it.each([
    'sidebar openTab',
    'mounted subscribe',
    'mounted snapshot',
    'tab definition register',
    'slot spec',
    'slot inject',
    'slot register',
    'layout',
  ] as const)('warns and fails closed when the public %s capability is missing', async (missing) => {
    const host = taskTabRuntime()
    switch (missing) {
      case 'sidebar openTab':
        host.provide('sidebarRight', { mounted: host.mounted })
        break
      case 'mounted subscribe':
        host.provide('sidebarRight', { openTab: host.openTab, mounted: { getSnapshot: host.mounted.getSnapshot } })
        break
      case 'mounted snapshot':
        host.provide('sidebarRight', { openTab: host.openTab, mounted: { subscribe: host.mounted.subscribe } })
        break
      case 'tab definition register':
        host.provide('sidebarRightTabs', {})
        break
      case 'slot spec':
        host.provide('slots', { inject: host.slots.inject, register: host.slots.register })
        break
      case 'slot inject':
        host.provide('slots', { spec: host.slots.spec, register: host.slots.register })
        break
      case 'slot register':
        host.provide('slots', { spec: host.slots.spec, inject: host.slots.inject })
        break
      case 'layout':
        host.provide('layout', undefined)
        break
    }
    expect(() => mount(host)).not.toThrow()
    await request()

    expect(host.registry.register).not.toHaveBeenCalled()
    expect(host.slots.register).not.toHaveBeenCalled()
    expectUnavailable(host)
    expect(console.warn).toHaveBeenCalledWith('[scheduler task tab] Public right-sidebar capability unavailable; task tabs disabled.')
  })

  it('fails closed and clears bindings when the public definition registry rejects installation', async () => {
    const host = taskTabRuntime()
    const error = new Error('definition rejected')
    const clear = vi.spyOn(TaskTabBindings.prototype, 'clear')
    host.registry.register.mockImplementationOnce(() => {
      throw error
    })
    expect(() => mount(host)).not.toThrow()
    await request()

    expect(host.definitions.size).toBe(0)
    expect(host.activeSeats.size).toBe(0)
    expect(host.seatInjections.size).toBe(0)
    expect(host.slots.inject).not.toHaveBeenCalled()
    expect(host.definitionDisposals).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledTimes(1)
    expectUnavailable(host)
    expect(console.warn).toHaveBeenCalledWith('[scheduler task tab] Public right-sidebar registration failed.', error)
  })

  it.each(['body', 'title'] as const)('rolls back the definition and prior contributions when the %s declaration wait itself throws', async (seat) => {
    const host = taskTabRuntime()
    const error = new Error(`${seat} declaration wait rejected`)
    const inject = host.slots.inject.getMockImplementation()!
    const clear = vi.spyOn(TaskTabBindings.prototype, 'clear')
    if (seat === 'title')
      host.slots.inject.mockImplementationOnce(inject)
    host.slots.inject.mockImplementationOnce(() => {
      throw error
    })
    expect(() => mount(host)).not.toThrow()
    await request()

    expect(host.definitions.size).toBe(0)
    expect(host.activeSeats.size).toBe(0)
    expect(host.seatInjections.size).toBe(0)
    expect(host.definitionDisposals).toHaveBeenCalledExactlyOnceWith('dsh-tauri-scheduler/task')
    expect(host.seatDisposals.mock.calls).toEqual(seat === 'title' ? [['sidebar.right.pane.tab']] : [])
    expect(host.injectionDisposals.mock.calls).toEqual(seat === 'title' ? [['sidebar.right.pane.tab']] : [])
    expect(clear).toHaveBeenCalledTimes(1)
    expectUnavailable(host)
    expect(console.warn).toHaveBeenCalledWith('[scheduler task tab] Public right-sidebar registration failed.', error)
  })

  it('rolls back partial installation when the body registration throws synchronously', async () => {
    const host = taskTabRuntime()
    const error = new Error('body contribution rejected')
    host.failRegistration('sidebar.right.pane.tab', error)
    const clear = vi.spyOn(TaskTabBindings.prototype, 'clear')
    expect(() => mount(host)).not.toThrow()
    await request()

    expect(host.definitions.size).toBe(0)
    expect(host.activeSeats.size).toBe(0)
    expect(host.seatInjections.size).toBe(0)
    expect(host.definitionDisposals).toHaveBeenCalledExactlyOnceWith('dsh-tauri-scheduler/task')
    expect(clear).toHaveBeenCalledTimes(1)
    expectUnavailable(host)
    expect(console.warn).toHaveBeenCalledWith('[scheduler task tab] Public right-sidebar registration failed.', error)
  })

  it('rolls back the already registered body and definition when the title contribution throws', async () => {
    const host = taskTabRuntime()
    const error = new Error('title contribution rejected')
    host.failRegistration('sidebar.right.pane.tab.title', error)
    mount(host)
    await request()

    expect(host.definitions.size).toBe(0)
    expect(host.activeSeats.size).toBe(0)
    expect(host.seatInjections.size).toBe(0)
    expect(host.seatDisposals).toHaveBeenCalledExactlyOnceWith('sidebar.right.pane.tab')
    expectUnavailable(host)
    expect(console.warn).toHaveBeenCalledWith('[scheduler task tab] Public right-sidebar registration failed.', error)
  })
})

describe('taskTabFeature requires both public seats before navigation', () => {
  it('does not open a blank task tab while both seats are undeclared', async () => {
    const host = taskTabRuntime({})
    const dispose = mount(host)
    expect(host.definitions.size).toBe(1)
    expect(host.slots.inject.mock.calls.map(([name]) => name)).toEqual([
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab.title',
    ])
    expect(host.activeSeats.size).toBe(0)
    await request()
    expectUnavailable(host)
    dispose()
    expectClean(host)
  })

  it.each(['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])('does not open a blank task tab when only %s has been declared', async (readySeat) => {
    const host = taskTabRuntime({ [readySeat]: { kind: 'keyed', scope: 'session' } })
    mount(host)
    expect(host.activeSeats.size).toBe(1)
    await request()
    expectUnavailable(host)
  })

  it('becomes navigable only after the second late declaration and clears the previous unavailable feedback', async () => {
    const host = taskTabRuntime({})
    mount(host)
    await request('neither-ready')
    expectUnavailable(host)
    host.declare('sidebar.right.pane.tab')
    await request('only-body-ready')
    expectUnavailable(host)
    host.declare('sidebar.right.pane.tab.title')
    await request('both-ready')

    expect(host.activeSeats.size).toBe(2)
    expect(host.openTab).toHaveBeenCalledExactlyOnceWith('scheduleTask', { params: { id: 'both-ready', sessionId: 'owner' } })
    expect(store.navigation.error).toBe('')
  })

  it.each([
    { name: 'sidebar.right.pane.tab', spec: { kind: 'list', scope: 'session' } },
    { name: 'sidebar.right.pane.tab', spec: { kind: 'keyed', scope: 'root' } },
    { name: 'sidebar.right.pane.tab.title', spec: { kind: 'list', scope: 'session' } },
    { name: 'sidebar.right.pane.tab.title', spec: { kind: 'keyed', scope: 'root' } },
  ] satisfies { name: string, spec: TaskTabSeatSpec }[])('warns without navigating for an incompatible $name $spec.kind/$spec.scope declaration', async ({ name, spec }) => {
    const host = taskTabRuntime({ ...taskTabSeats, [name]: spec })
    mount(host)
    expect(host.activeSeats.size).toBe(1)
    await request()

    expectUnavailable(host)
    expect(console.warn).toHaveBeenCalledWith('[scheduler task tab] Public right-sidebar capability unavailable; task tabs disabled.')
  })

  it.each(['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])('loses readiness when %s collapses and recovers without duplicating contributions', async (name) => {
    const host = taskTabRuntime()
    mount(host)
    host.collapse(name)
    expect(host.activeSeats.size).toBe(1)
    await request('collapsed')
    expectUnavailable(host)
    host.declare(name)
    await request('redeclared')

    expect(host.activeSeats.size).toBe(2)
    expect(host.openTab).toHaveBeenCalledExactlyOnceWith('scheduleTask', { params: { id: 'redeclared', sessionId: 'owner' } })
    expect(host.seatDisposals).toHaveBeenCalledWith(name)
  })

  it.each([
    { failed: 'sidebar.right.pane.tab', ready: 'sidebar.right.pane.tab.title' },
    { failed: 'sidebar.right.pane.tab.title', ready: 'sidebar.right.pane.tab' },
  ])('keeps navigation disabled when the late compatible $failed contribution fails to register', async ({ failed, ready }) => {
    const host = taskTabRuntime({ [ready]: { kind: 'keyed', scope: 'session' } })
    const error = new Error('late contribution rejected')
    host.failRegistration(failed, error)
    const dispose = mount(host)
    host.declare(failed)
    expect(host.activeSeats.size).toBe(1)
    expect(host.declarationFailures).toEqual([error])
    await request()

    expectUnavailable(host)
    dispose()
    expectClean(host)
  })

  it('does not register late seats after the feature and its waits have been disposed', async () => {
    const host = taskTabRuntime({})
    const dispose = mount(host)
    dispose()
    host.declare('sidebar.right.pane.tab')
    host.declare('sidebar.right.pane.tab.title')
    await request('disposed')

    expectClean(host)
    expect(host.slots.register).not.toHaveBeenCalled()
    expect(host.openTab).not.toHaveBeenCalled()
  })
})

describe('taskTabFeature aborts lifecycle-owned navigation when its rendering capabilities unload', () => {
  it.each(['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])('aborts pending navigation when %s collapses and cannot open after mounted publishes', async (name) => {
    const host = taskTabRuntime()
    host.mounted.publish(undefined)
    const dispose = mount(host)
    await request()
    expect(host.mounted.listeners.size).toBe(1)
    host.collapse(name)
    await vi.advanceTimersByTimeAsync(0)

    expect(host.activeSeats.size).toBe(1)
    expect(host.openTab).not.toHaveBeenCalled()
    expect(host.mounted.listeners.size).toBe(0)
    expect(host.panelInfo.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    host.mounted.publish('owner' as NonNullable<ReturnType<typeof host.mounted.getSnapshot>>)
    await vi.advanceTimersByTimeAsync(0)
    expect(host.openTab).not.toHaveBeenCalled()
    dispose()
    expectClean(host)
  })

  it('aborts an already pending navigation before unloading its body and title contributions', async () => {
    const host = taskTabRuntime()
    host.mounted.publish(undefined)
    mount(host)
    await request()
    expect(host.mounted.listeners.size).toBe(1)
    host.provide('sidebarRight', undefined)
    await vi.advanceTimersByTimeAsync(0)

    expect(host.openTab).not.toHaveBeenCalled()
    expect(host.activeSeats.size).toBe(0)
    expect(host.mounted.listeners.size).toBe(0)
    expect(host.panelInfo.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not leave a request alive after full plugin disposal', async () => {
    const host = taskTabRuntime()
    host.mounted.publish(undefined)
    const dispose = mount(host)
    await request()
    dispose()
    await vi.advanceTimersByTimeAsync(0)

    expectClean(host)
    host.mounted.publish('owner' as NonNullable<ReturnType<typeof host.mounted.getSnapshot>>)
    await vi.advanceTimersByTimeAsync(0)
    expect(host.openTab).not.toHaveBeenCalled()
  })
})
