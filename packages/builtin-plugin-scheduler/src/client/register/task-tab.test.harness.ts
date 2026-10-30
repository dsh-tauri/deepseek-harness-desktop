import type { ILayout, MainPanelId, SessionId, SessionListState, WorkspaceSnapshot } from 'dsh-tauri/client'
import type { TaskTabInjected } from '../components/task-tab'
import type { SidebarRightTabs, TaskTabNavigation } from '../types/task-tab'
import { vi } from 'vitest'

export interface TaskTabSeatSpec {
  kind: string
  scope: string
}

interface TaskTabSeatEntry {
  name: string
  key: string
  inject: () => TaskTabInjected
}

interface SeatInjection {
  name: string
  setup: () => () => void
  cleanup?: () => void
  stopped: boolean
}

interface ServiceInjection {
  names: readonly string[]
  setup: (scope: object) => unknown
  snapshot?: readonly unknown[]
  cleanup?: () => void
  loaded: boolean
  stopped: boolean
}

export const taskTabSeats: Readonly<Record<string, TaskTabSeatSpec>> = {
  'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
  'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
}

function observable<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    listeners,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    publish(value: T) {
      snapshot = value
      for (const listener of [...listeners])
        listener()
    },
  }
}

export function taskTabRuntime(initial: Readonly<Record<string, TaskTabSeatSpec>> = taskTabSeats) {
  const specs = new Map(Object.entries(initial))
  const seatInjections = new Set<SeatInjection>()
  const serviceInjections = new Set<ServiceInjection>()
  const activeSeats = new Map<string, { entry: TaskTabSeatEntry, component: unknown }>()
  const definitions = new Map<string, Parameters<SidebarRightTabs['register']>[0]>()
  const registrationFailures = new Map<string, Error>()
  const declarationFailures: unknown[] = []
  const seatDisposals = vi.fn((_name: string) => {})
  const injectionDisposals = vi.fn((_name: string) => {})
  const definitionDisposals = vi.fn((_id: string) => {})
  const fiberDisposals = vi.fn()

  function stopSeat(record: SeatInjection) {
    if (record.stopped)
      return
    record.stopped = true
    record.cleanup?.()
    record.cleanup = undefined
    seatInjections.delete(record)
    injectionDisposals(record.name)
  }

  const slots = {
    spec: vi.fn((name: string) => specs.get(name)),
    inject: vi.fn((name: string, setup: () => () => void) => {
      const record: SeatInjection = { name, setup, stopped: false }
      seatInjections.add(record)
      try {
        if (specs.has(name))
          record.cleanup = setup()
      }
      catch (error) {
        stopSeat(record)
        throw error
      }
      return () => stopSeat(record)
    }),
    register: vi.fn((entry: TaskTabSeatEntry, component: unknown) => {
      const failure = registrationFailures.get(entry.name)
      if (failure)
        throw failure
      const key = `${entry.name}:${entry.key}`
      if (activeSeats.has(key))
        throw new Error('Duplicate task tab seat contribution')
      activeSeats.set(key, { entry, component })
      let disposed = false
      return () => {
        if (disposed)
          return
        disposed = true
        activeSeats.delete(key)
        seatDisposals(entry.name)
      }
    }),
  }
  const registry = {
    register: vi.fn((definition: Parameters<SidebarRightTabs['register']>[0]) => {
      if (definitions.has(definition.id))
        throw new Error('Duplicate task tab definition')
      definitions.set(definition.id, definition)
      let disposed = false
      return () => {
        if (disposed)
          return
        disposed = true
        definitions.delete(definition.id)
        definitionDisposals(definition.id)
      }
    }),
  }
  const owner = 'owner' as SessionId
  const sessionList = observable<SessionListState & { current: SessionId }>({
    ids: [owner],
    byId: {
      [owner]: { id: owner, displayTitle: 'Owner', running: false, retainedBy: {}, blank: false, updatedAt: 0 },
    },
    projectionsBySession: {},
    current: owner,
    phase: 'ready',
  })
  const workspaceList = observable<WorkspaceSnapshot>({
    items: [],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
  })
  const mounted = observable<SessionId | undefined>(owner)
  const panelInfo = observable<{ activePanelId: MainPanelId | null }>({ activePanelId: 'scheduler' as MainPanelId })
  const openTab = vi.fn((_kind: string, _options: { params: TaskTabNavigation }) => {})
  const openSession = vi.fn((_id: string): unknown => undefined)
  const startSession = vi.fn((): unknown => undefined)
  const sidebar = { mounted, openTab, tabsIn: vi.fn((_id: SessionId) => []) }
  const layout: ILayout = {
    panelInfo,
    selectPanel: vi.fn((id: MainPanelId | null) => panelInfo.publish({ activePanelId: id })),
    beginNavigation: () => new AbortController().signal,
    toggleSidebar: vi.fn(),
    openRightbar: vi.fn(),
    closeRightbar: vi.fn(),
  }
  const sessions = { list: sessionList }
  const workspaces = { list: workspaceList }
  const services = new Map<string, unknown>([
    ['sidebarRight', sidebar],
    ['sidebarRightTabs', registry],
    ['slots', slots],
    ['layout', layout],
    ['sessions', sessions],
    ['workspaces', workspaces],
    ['uiWorkspace', { openSession, startSession }],
  ])

  function reconcile(record: ServiceInjection, scope: object) {
    if (record.stopped)
      return
    const snapshot = record.names.map(name => services.get(name))
    const ready = snapshot.every(value => value !== undefined)
    if (record.loaded && ready && snapshot.every((value, index) => value === record.snapshot?.[index]))
      return
    record.cleanup?.()
    record.cleanup = undefined
    record.loaded = false
    record.snapshot = undefined
    if (!ready)
      return
    record.loaded = true
    record.snapshot = snapshot
    const cleanup = record.setup(scope)
    if (typeof cleanup === 'function')
      record.cleanup = () => { cleanup() }
  }

  const context = {
    sessions,
    workspaces,
    get: vi.fn((name: string) => services.get(name)),
    inject: vi.fn((names: string[], setup: (scope: object) => unknown) => {
      const record: ServiceInjection = { names, setup, loaded: false, stopped: false }
      serviceInjections.add(record)
      reconcile(record, context)
      return {
        dispose: vi.fn(() => {
          if (!record.stopped) {
            record.stopped = true
            record.cleanup?.()
            record.cleanup = undefined
            serviceInjections.delete(record)
            fiberDisposals()
          }
          return Promise.resolve()
        }),
      }
    }),
  }

  return {
    context,
    slots,
    registry,
    sidebar,
    layout,
    mounted,
    panelInfo,
    sessionList,
    workspaceList,
    openTab,
    openSession,
    startSession,
    activeSeats,
    definitions,
    seatInjections,
    serviceInjections,
    declarationFailures,
    seatDisposals,
    injectionDisposals,
    definitionDisposals,
    fiberDisposals,
    provide(name: string, service: unknown) {
      if (service === undefined)
        services.delete(name)
      else
        services.set(name, service)
      for (const record of [...serviceInjections])
        reconcile(record, context)
    },
    failRegistration(name: string, error: Error) {
      registrationFailures.set(name, error)
    },
    declare(name: string, spec: TaskTabSeatSpec = { kind: 'keyed', scope: 'session' }) {
      specs.set(name, spec)
      for (const record of [...seatInjections]) {
        if (record.name !== name || record.stopped)
          continue
        record.cleanup?.()
        record.cleanup = undefined
        try {
          record.cleanup = record.setup()
        }
        catch (error) {
          stopSeat(record)
          declarationFailures.push(error)
        }
      }
    },
    collapse(name: string) {
      specs.delete(name)
      for (const record of [...seatInjections]) {
        if (record.name !== name)
          continue
        record.cleanup?.()
        record.cleanup = undefined
      }
    },
  }
}
