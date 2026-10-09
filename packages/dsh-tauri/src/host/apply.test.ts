import type { HostContext, IndexInjectRow } from './types'
import { createContext, runInContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from './apply'

afterEach(() => {
  vi.unstubAllEnvs()
})

function activate() {
  let inject: ((table: IndexInjectRow[]) => void) | undefined
  const on = vi.fn((event: string, listener: (table: IndexInjectRow[]) => void) => {
    expect(event).toBe('webserver/index-inject')
    inject = listener
    return () => {
      inject = undefined
    }
  })
  const ctx = {
    connection: { authorizeIndex: () => false },
    effect: (callback: () => unknown) => { callback() },
    on,
  } as unknown as HostContext
  apply(ctx)
  return { on, collect: (): IndexInjectRow[] => {
    const table: IndexInjectRow[] = []
    inject?.(table)
    return table
  } }
}

/** 在最小页面语境里执行注入脚本，取回 `globalThis.dshDesktop` 的落地值。 */
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
  /** 官方账号 UI 的准入就是 `'dshDesktop' in globalThis`，因此这里验的是真实脚本行为。 */
  it('marks the embedded index only when the shell claimed it', async () => {
    vi.stubEnv('DSH_TAURI_EMBEDDED', '1')
    const { collect, on } = activate()

    expect(on).toHaveBeenCalledOnce()
    const rows = collect()
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.kind).toBe('script')
    expect(row?.kind === 'script' ? row.placement : undefined).toBe('head')

    const script = row?.kind === 'script' ? row.text : ''
    // 与官方 preload 的非 app 来源分支同值：只声明协议版本，产品 API 一律缺席。
    const carrier = runMarker(script, '?t=1&dshDesktop=1')
    expect(carrier?.protocolVersion).toBe(1)
    expect(carrier?.updates).toBeUndefined()
    expect(carrier?.browser).toBeUndefined()
    // 官方 0.2.0 反馈表单读 `dshDesktop.deviceInfo?.()`；Tauri 侧以 userAgent 兜底。
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
