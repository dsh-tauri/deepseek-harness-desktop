import type { HostPluginLoader } from 'dsh-tauri'
import type { PlatformPluginLoader } from './provider.types'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { loadFilesystemSkillPlugin } from './provider.utils'

afterEach(() => vi.restoreAllMocks())

describe('loadFilesystemSkillPlugin', () => {
  it('accepts the host loader contract through its existing exported type name', async () => {
    expectTypeOf<PlatformPluginLoader>().toEqualTypeOf<HostPluginLoader>()
    const exports = { default: { name: 'filesystem', apply: vi.fn() } }
    const loader: HostPluginLoader = { import: vi.fn().mockResolvedValue(exports), unwrapExports: vi.fn(() => exports.default) }
    await expect(loadFilesystemSkillPlugin(loader)).resolves.toBe(exports.default)
    expect(loader.import).toHaveBeenCalledExactlyOnceWith('@deepseek-ai/dsh-skill-filesystem')
    expect(loader.unwrapExports).toHaveBeenCalledExactlyOnceWith(exports)
  })

  it('propagates import failures without trying to unwrap exports', async () => {
    const error = new Error('missing filesystem plugin')
    const loader: HostPluginLoader = { import: vi.fn().mockRejectedValue(error), unwrapExports: vi.fn() }
    await expect(loadFilesystemSkillPlugin(loader)).rejects.toBe(error)
    expect(loader.unwrapExports).not.toHaveBeenCalled()
  })
})
