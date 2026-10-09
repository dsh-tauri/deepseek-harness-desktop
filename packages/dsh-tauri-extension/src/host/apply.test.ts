import type { HostContext } from 'dsh-tauri'
import { getServerContext } from 'dsh-h3/utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, packagedSkillsDir } from './apply'
import { disposeProviderRuntime, providerRuntime } from './config/runtime'
import { server } from './server'

vi.mock('./service/provider', () => ({ provider: { start: vi.fn().mockResolvedValue(undefined) } }))
vi.mock('./service/profile', () => ({ profile: { resolve: () => null, peek: (name: string) => `/profiles/${name}` } }))

const { provider } = await import('./service/provider')
const disposers: Array<() => void> = []

afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  disposeProviderRuntime()
  vi.clearAllMocks()
})

describe('apply provider lifecycle', () => {
  it('activates the server before starting packaged skills and cleans both lifecycles', async () => {
    const effects = new Map<string, () => (() => void)>()
    const host = { marker: 'host', webServer: { register: vi.fn(() => () => {}) } }
    const ctx = {
      inject: vi.fn((_names: string[], callback: (context: unknown) => unknown) => callback(host)),
      effect: vi.fn((effect: () => (() => void), label: string) => effects.set(label, effect)),
    }
    apply(ctx as unknown as HostContext, { profile: 'chosen' })
    expect(ctx.inject).toHaveBeenCalledWith(inject, expect.any(Function))
    expect([...effects.keys()]).toEqual(['dsh-tauri-extension: routes', 'dsh-tauri-extension: skill provider'])
    expect(provider.start).not.toHaveBeenCalled()
    expect(providerRuntime.disposed).toBe(false)
    expect(() => getServerContext(server)).toThrow()
    const unmount = effects.get('dsh-tauri-extension: routes')!()
    disposers.push(unmount)
    expect(getServerContext(server)).toBe(host)
    const dispose = effects.get('dsh-tauri-extension: skill provider')!()
    expect(provider.start).toHaveBeenCalledExactlyOnceWith(packagedSkillsDir())
    expect(dispose).toBe(disposeProviderRuntime)
    expect(server.__host_instance!.options.hotReload()).toBe(false)
    await server.__host_instance!.options.remountProvider()
    expect(server.__host_instance!.options.profileDirPath).toBe('/profiles/chosen')
    expect(provider.start).toHaveBeenCalledTimes(2)
    dispose()
    expect(providerRuntime.disposed).toBe(true)
    expect(providerRuntime.fiber).toBeUndefined()
    unmount()
    expect(() => getServerContext(server)).toThrow()
  })

  it('宿主挂载 hmr 服务时报告可热加载', () => {
    const effects = new Map<string, () => (() => void)>()
    const host = {
      marker: 'host',
      webServer: { register: vi.fn(() => () => {}) },
      get: (name: string) => (name === 'hmr' ? { runExclusive: async () => {} } : undefined),
    }
    const ctx = {
      inject: vi.fn((_names: string[], callback: (context: unknown) => unknown) => callback(host)),
      effect: vi.fn((effect: () => (() => void), label: string) => effects.set(label, effect)),
    }
    apply(ctx as unknown as HostContext)
    expect(providerRuntime.disposed).toBe(false)
    disposers.push(effects.get('dsh-tauri-extension: routes')!())
    expect(server.__host_instance!.options.hotReload()).toBe(true)
  })
})
