import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { packSkills } from './local'
import { buildPluginsBundle } from './plugins-sync'

const { execFileAsync } = vi.hoisted(() => ({ execFileAsync: vi.fn() }))

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execFileAsync }) }
})

afterEach(() => vi.resetAllMocks())

describe('packSkills', () => {
  it('packs the selected names directly with bounded binary output', async () => {
    const archive = Buffer.from('tar output')
    execFileAsync.mockResolvedValue({ stdout: archive, stderr: Buffer.alloc(0) })
    expect(await packSkills('/skills', ['alpha', '-beta'])).toBe(archive)
    expect(execFileAsync).toHaveBeenCalledWith('tar', ['-cf', '-', '-C', '/skills', '--', 'alpha', '-beta'], {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      encoding: 'buffer',
    })
  })

  it('rejects an empty archive with the stderr diagnostic', async () => {
    execFileAsync.mockResolvedValue({ stdout: Buffer.alloc(0), stderr: Buffer.from(' nothing packed\n') })
    await expect(packSkills('/skills', ['alpha'])).rejects.toThrow('packing skills produced no archive: nothing packed')
  })
})

describe('buildPluginsBundle process lifecycle', () => {
  it('closes tar stdin before awaiting output and cleans the staging directory', async () => {
    const archive = Buffer.from('plugin tar output')
    let finish!: (output: { stdout: Buffer, stderr: Buffer }) => void
    const pending = new Promise<{ stdout: Buffer, stderr: Buffer }>((resolve) => {
      finish = resolve
    })
    const end = vi.fn(() => finish({ stdout: archive, stderr: Buffer.alloc(0) }))
    execFileAsync.mockReturnValue(Object.assign(pending, { child: { stdin: { end } } }))
    const result = await buildPluginsBundle({ root: '/plugins', pluginNames: ['plugin-a'] })
    expect(end).toHaveBeenCalledOnce()
    expect(result.tar).toBe(archive)
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(execFileAsync).toHaveBeenCalledWith('tar', ['-czf', '-', '-C', '/plugins', '.', '-C', expect.any(String), '_wire.js'], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer',
    })
    expect(existsSync(execFileAsync.mock.calls[0]![1][6])).toBe(false)
  })

  it('propagates tar failures and still cleans the staging directory without stdin', async () => {
    const error = new Error('tar failed')
    execFileAsync.mockReturnValue(Object.assign(Promise.reject(error), { child: { stdin: null } }))
    await expect(buildPluginsBundle({ root: '/plugins', pluginNames: [] })).rejects.toBe(error)
    expect(existsSync(execFileAsync.mock.calls[0]![1][6])).toBe(false)
  })
})
