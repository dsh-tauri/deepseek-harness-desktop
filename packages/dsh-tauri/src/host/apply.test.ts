import type { HostContext, IndexInjectRow } from './types'
import { createContext, runInContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from './apply'
import { clearHostRuntime } from './config/runtime'

afterEach(() => {
  vi.unstubAllEnvs()
  clearHostRuntime()
})

async function activate() {
  let inject: ((table: IndexInjectRow[]) => void) | undefined
  const pendingEffects: Promise<unknown>[] = []
  const disposers: Array<() => void> = []
  const on = vi.fn((event: string, listener: (table: IndexInjectRow[]) => void) => {
    expect(event).toBe('webserver/index-inject')
    inject = listener
    return () => {
      inject = undefined
    }
  })
  class FakeHttpFetchProvider {
    readonly id = 'http'

    constructor(readonly resolveAddresses?: unknown) {}

    available(): boolean {
      return true
    }

    fetch(): Promise<unknown> {
      return Promise.resolve({})
    }
  }
  const loader = {
    import: vi.fn(async (name: string) => name === '@deepseek-ai/dsh-web'
      ? { WebError: class extends Error {} }
      : { Config: () => ({}), HttpFetchProvider: FakeHttpFetchProvider }),
    unwrapExports: vi.fn((value: unknown) => value),
  }
  const registeredDisposer = vi.fn()
  const registerFetchProvider = vi.fn(() => registeredDisposer)
  const web = {
    registerFetchProvider,
  }
  const ctx = {
    connection: { authorizeIndex: () => false },
    effect: (callback: () => unknown) => {
      const result = callback()
      if (result !== null && typeof result === 'object' && 'then' in result) {
        pendingEffects.push(Promise.resolve(result).then((dispose) => {
          if (typeof dispose === 'function')
            disposers.push(dispose as () => void)
        }))
      }
      else if (typeof result === 'function') {
        disposers.push(result as () => void)
      }
    },
    loader,
    on,
    web,
  } as unknown as HostContext
  apply(ctx)
  await Promise.all(pendingEffects)
  return {
    on,
    collect: (): IndexInjectRow[] => {
      const table: IndexInjectRow[] = []
      inject?.(table)
      return table
    },
    dispose: () => {
      for (const dispose of disposers.splice(0))
        dispose()
    },
    registerFetchProvider,
    registeredDisposer,
  }
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
    const { collect, on, registeredDisposer, dispose, registerFetchProvider } = await activate()

    expect(registeredDisposer).not.toHaveBeenCalled()
    expect(registerFetchProvider).toHaveBeenCalledOnce()
    expect(registerFetchProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'http' }))
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
    dispose()
    expect(registeredDisposer).toHaveBeenCalledOnce()
  })

  it('does not advertise a desktop carrier to standalone web', async () => {
    vi.stubEnv('DSH_TAURI_EMBEDDED', '0')
    const { collect, on, registeredDisposer, dispose } = await activate()

    expect(on).not.toHaveBeenCalled()
    expect(collect()).toEqual([])
    dispose()
    expect(registeredDisposer).toHaveBeenCalledOnce()
  })
})
