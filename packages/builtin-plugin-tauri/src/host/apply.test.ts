import type { HostContext, IndexInjectRow } from './types'
import { createContext, runInContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from './apply'

afterEach(() => {
  vi.unstubAllEnvs()
})

function activate() {
  const listeners: ((table: IndexInjectRow[]) => void)[] = []
  const on = vi.fn((event: string, listener: (table: IndexInjectRow[]) => void) => {
    expect(event).toBe('webserver/index-inject')
    listeners.push(listener)
    return () => {
      const index = listeners.indexOf(listener)
      if (index >= 0) {
        listeners.splice(index, 1)
      }
    }
  })
  const ctx = {
    connection: { authorizeIndex: () => false },
    webServer: { register: () => () => {} },
    effect: (callback: () => unknown) => { callback() },
    on,
  } as unknown as HostContext
  apply(ctx)
  return { on, collect: (): IndexInjectRow[] => {
    const table: IndexInjectRow[] = []
    for (const listener of listeners) listener(table)
    return table
  } }
}

interface Marker {
  protocolVersion?: number
  deviceInfo?: () => Promise<string>
  updates?: unknown
  browser?: unknown
}

function runMarker(script: string, search: string): Marker | undefined {
  const sandbox: Record<string, unknown> = { location: { search }, URLSearchParams, navigator: { userAgent: 'tauri-test-agent' } }
  runInContext(script, createContext(sandbox))
  return sandbox.dshDesktop as Marker | undefined
}

describe('desktop account marker', () => {
  it('marks the embedded index only when the shell claimed it', async () => {
    vi.stubEnv('DSH_TAURI_EMBEDDED', '1')
    const { collect, on } = activate()

    expect(on).toHaveBeenCalled()
    const rows = collect()
    const row = rows.find(item => item.kind === 'script' && item.text.includes('protocolVersion'))
    expect(row?.kind).toBe('script')
    expect(row?.kind === 'script' ? row.placement : undefined).toBe('head')

    const script = row?.kind === 'script' ? row.text : ''
    const carrier = runMarker(script, '?t=1&dshDesktop=1')
    expect(carrier?.protocolVersion).toBe(1)
    expect(carrier?.updates).toBeUndefined()
    expect(carrier?.browser).toBeUndefined()
    await expect(carrier?.deviceInfo?.()).resolves.toBe('tauri-test-agent')
    expect(runMarker(script, '?t=1')).toBeUndefined()
  })

  it('does not advertise a desktop carrier to standalone web', () => {
    vi.stubEnv('DSH_TAURI_EMBEDDED', '0')
    const { collect, on } = activate()

    expect(on).not.toHaveBeenCalled()
    expect(collect()).toEqual([])
  })
})
