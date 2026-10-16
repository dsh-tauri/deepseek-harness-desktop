// @vitest-environment jsdom
import type { DshPetConfig } from 'dsh-pet-component'
import { clearMocks, mockConvertFileSrc } from '@tauri-apps/api/mocks'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assetSource, usePetSource } from './use-pet-source'

const { invoke, useListen } = vi.hoisted(() => ({ invoke: vi.fn(), useListen: vi.fn() }))
vi.mock('@/hooks/use-listen', () => ({ useListen }))
vi.mock('@tauri-apps/api/core', async importOriginal => ({ ...await importOriginal<typeof import('@tauri-apps/api/core')>(), invoke }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function asset(id: string) {
  return { kind: 'codex' as const, id, spritesheet: `data:image/png;base64,${id}`, sprite_version_number: 2, columns: 8, rows: 9 }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  clearMocks()
})

describe('local pet asset sources', () => {
  it.each(['windows', 'macos'] as const)('converts local directories containing Chinese and spaces into %s asset URL templates', (os) => {
    mockConvertFileSrc(os)
    const config: DshPetConfig = { animations: { idle: ['待机 呼吸'] } }
    const source = assetSource({
      kind: 'dsh',
      id: 'chat:video',
      config,
      uri: { default: 'E:\\宠物 space\\webm', mac: '/宠物 space/mov' },
      ext: { default: 'webm', mac: 'mov' },
      size: 260,
    })
    const prefix = os === 'windows' ? 'http://asset.localhost/' : 'asset://localhost/'
    expect(source).toEqual({
      kind: 'dsh',
      config,
      uri: {
        default: `${prefix}E%3A%5C%E5%AE%A0%E7%89%A9%20space%5Cwebm/{name}.{ext}`,
        mac: `${prefix}%2F%E5%AE%A0%E7%89%A9%20space%2Fmov/{name}.{ext}`,
      },
      ext: { default: 'webm', mac: 'mov' },
      aspect: 9 / 16,
      width: 260,
      cache: false,
    })
    expect(source.config).toBe(config)
  })

  it('preserves default-only local paths and default video width', () => {
    mockConvertFileSrc('windows')
    expect(assetSource({ kind: 'dsh', id: 'chat:video', config: {}, uri: { default: 'E:/pets/webm' }, ext: { default: 'webm' } })).toEqual({
      kind: 'dsh',
      config: {},
      uri: { default: 'http://asset.localhost/E%3A%2Fpets%2Fwebm/{name}.{ext}' },
      ext: { default: 'webm' },
      aspect: 9 / 16,
      width: 220,
      cache: false,
    })
  })

  it.each([1, 2, 99])('preserves Codex data URLs and snake_case atlas version %s', (version) => {
    expect(assetSource({ ...asset('codex:atlas'), sprite_version_number: version })).toEqual({
      kind: 'codex',
      config: { spriteVersionNumber: version === 1 ? 1 : 2, columns: 8, rows: 9 },
      uri: 'data:image/png;base64,codex:atlas',
      aspect: 208 / 192,
      width: 220,
      cache: true,
    })
  })
})

describe('pet source requests', () => {
  it('routes qualified chat video IDs through get_pet_asset without loading presets', async () => {
    mockConvertFileSrc('windows')
    const config: DshPetConfig = { motions: { idle: '待机' } }
    invoke.mockResolvedValue({ kind: 'dsh', id: 'chat:video', config, uri: { default: 'E:/pets/webm' }, ext: { default: 'webm' } })
    const { result } = renderHook(() => usePetSource('chat:video'))
    await act(async () => {})
    expect(invoke).toHaveBeenCalledExactlyOnceWith('get_pet_asset', { id: 'chat:video' })
    expect(result.current).toEqual({
      source: {
        kind: 'dsh',
        config,
        uri: { default: 'http://asset.localhost/E%3A%2Fpets%2Fwebm/{name}.{ext}' },
        ext: { default: 'webm' },
        aspect: 9 / 16,
        width: 220,
        cache: false,
      },
      error: null,
    })
  })

  it('keeps remote presets cached with their original URL and video geometry', async () => {
    invoke.mockResolvedValue([{ id: 'preset', name: 'Preset', config: 'https://cdn/config.jsonc', uri: { default: 'https://cdn/webm' } }])
    const { result } = renderHook(() => usePetSource('preset'))
    await act(async () => {})
    expect(invoke).toHaveBeenCalledExactlyOnceWith('list_preset_pets')
    expect(result.current.source).toEqual({
      kind: 'dsh',
      config: 'https://cdn/config.jsonc',
      uri: { default: 'https://cdn/webm' },
      ext: undefined,
      aspect: 9 / 16,
      width: 220,
      cache: true,
    })
  })

  it('reloads an active preset on catalog updates with new commit URLs but ignores unrelated pets', async () => {
    const spec = { id: 'pet', name: 'Pet', config: 'https://raw/old/config.jsonc', uri: { default: 'https://raw/old/webm' } }
    invoke.mockResolvedValueOnce([spec]).mockResolvedValueOnce([{ ...spec, config: 'https://raw/new/config.jsonc', uri: { default: 'https://raw/new/webm' } }])
    const { result } = renderHook(() => usePetSource('pet'))
    await act(async () => {})
    const handler = useListen.mock.calls.at(-1)![1]
    expect(useListen.mock.calls.at(-1)![0]).toBe('pet://catalog')
    await act(async () => {
      handler({ payload: 'other' })
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    await act(async () => {
      handler({ payload: 'pet' })
    })
    expect(invoke.mock.calls).toEqual([['list_preset_pets'], ['list_preset_pets']])
    expect(result.current.source?.config).toBe('https://raw/new/config.jsonc')
    expect(result.current.source?.uri).toEqual({ default: 'https://raw/new/webm' })
  })

  it.each(['resolve', 'reject'] as const)('preserves the current pet when an older request finishes with %s', async (completion) => {
    const old = deferred<ReturnType<typeof asset>>()
    invoke.mockImplementation((command, args) => command === 'log_frontend' ? Promise.resolve() : args.id === 'codex:old' ? old.promise : Promise.resolve(asset(args.id)))
    const { result, rerender } = renderHook(({ id }) => usePetSource(id), { initialProps: { id: 'codex:old' } })
    rerender({ id: 'codex:new' })
    await act(async () => {})
    expect(result.current.source?.uri).toBe('data:image/png;base64,codex:new')
    await act(async () => {
      if (completion === 'resolve')
        old.resolve(asset('codex:old'))
      else
        old.reject(new Error('old request failed'))
    })
    expect(result.current.source?.uri).toBe('data:image/png;base64,codex:new')
    expect(result.current.error).toBeNull()
  })

  it('does not restore an asset after selection is cleared', async () => {
    const pending = deferred<ReturnType<typeof asset>>()
    invoke.mockReturnValue(pending.promise)
    const { result, rerender } = renderHook(({ id }) => usePetSource(id), { initialProps: { id: 'codex:old' } })
    rerender({ id: '' })
    await act(async () => {
      pending.resolve(asset('codex:old'))
    })
    expect(result.current).toEqual({ source: null, error: null })
  })
})
