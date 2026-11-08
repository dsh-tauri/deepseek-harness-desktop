import type { ChildProcess, SpawnOptions } from 'node:child_process'
import process from 'node:process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.fn((_file: string, _args: readonly string[], _options: SpawnOptions) => ({ pid: 4242, unref: vi.fn() }) as unknown as ChildProcess)

vi.mock('node:child_process', () => ({ spawn: (file: string, args: readonly string[], options: SpawnOptions) => spawn(file, args, options) }))
vi.mock('node:fs', () => ({ openSync: () => 7 }))
vi.mock('node:os', () => ({ tmpdir: () => '/tmp' }))

const { restart } = await import('./restart')

const asarEntry = '/home/u/.local/share/dsh-tauri/dependencies/dsh/deepseek-harness-pkg-linux-x64.asar/node_modules/@deepseek-ai/dsh/lib/bin.js'

const cliEntry = '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'

const originalArgv = process.argv

beforeEach(() => {
  vi.useFakeTimers()
  spawn.mockClear()
})

describe('restart.start', () => {
  it('spawns the replacement from the inherited cwd when the entry lives inside an asar archive', () => {
    process.argv = ['node', asarEntry, '--port', '3080']
    const outcome = restart.start()
    expect(outcome.replacementPid).toBe(4242)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]![2]).toMatchObject({ cwd: undefined, shell: false })
    expect(outcome.logOut).toMatch(/^\/tmp\/dsh-tauri-extension-restart-.*\.out\.log$/)
  })

  it('spawns the replacement next to a plain cli entry', () => {
    process.argv = ['node', cliEntry, '--port', '3080']
    restart.start()
    expect(spawn.mock.calls[0]![2]).toMatchObject({ cwd: '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib' })
  })

  it('restarts the host itself even when the desktop marker env is present', () => {
    process.env.DSH_DESKTOP = '1'
    process.argv = ['node', asarEntry]
    try {
      expect(restart.start().replacementPid).toBe(4242)
      expect(spawn).toHaveBeenCalledTimes(1)
    }
    finally {
      process.argv = originalArgv
      delete process.env.DSH_DESKTOP
      vi.useRealTimers()
    }
  })
})
