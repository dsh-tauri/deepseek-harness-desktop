import { vi } from 'vitest'

type Handler = (event: { event: string, id: number, payload: unknown }) => void

const handlers = new Map<string, Set<Handler>>()

export const emitted: Array<{ event: string, payload: unknown }> = []

export const tauriMock = {
  invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined),
  emit: vi.fn(async (event: string, payload?: unknown) => {
    emitted.push({ event, payload })
  }),
  listen: vi.fn(async (event: string, handler: Handler) => {
    const set = handlers.get(event) ?? new Set()
    set.add(handler)
    handlers.set(event, set)
    return () => {
      set.delete(handler)
    }
  }),
  once: vi.fn(),
}

export function dispatchEvent(event: string, payload?: unknown): void {
  for (const handler of [...(handlers.get(event) ?? [])])
    handler({ event, id: 0, payload })
}

export function listenerCount(): number {
  return [...handlers.values()].reduce((total, set) => total + set.size, 0)
}

export function emittedOf(event: string): unknown[] {
  return emitted.filter(item => item.event === event).map(item => item.payload)
}

export function clearEmitted(): void {
  emitted.length = 0
}

export function resetTauriMock(): void {
  handlers.clear()
  emitted.length = 0
  tauriMock.invoke.mockClear()
  tauriMock.emit.mockClear()
  tauriMock.listen.mockClear()
}
