import type { RemoteExecOptions, RemoteExecResult, RemoteSession } from '../types/index'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MachineId } from '../types/index'
import { core } from './core'
import { machine } from './machine'
import { tasks } from './tasks'

const listGithubReleases = vi.hoisted(() => vi.fn())
const listGithubAssets = vi.hoisted(() => vi.fn())

vi.mock('dsh-tauri', () => ({ defineService: <T>(service: T): T => service }))
vi.mock('../config/runtime', () => ({ hostConfig: () => ({ installRepo: undefined }) }))
vi.mock('../utils/version', async importOriginal => ({
  ...await importOriginal<typeof import('../utils/version')>(),
  listGithubReleases,
  listGithubAssets,
}))
vi.mock('./machine', () => ({
  machine: {
    openSession: vi.fn(),
    profileName: vi.fn(),
  },
}))

const machineId = MachineId('remote-core-test')
const canTestUnixDirectoryMode = process.platform !== 'win32'
  && (process.getuid?.() ?? 1) !== 0
const entryPath = '/home/remote/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'

interface RemoteCopyFixture {
  name: string
  dir: string
  entry?: string
  pkg?: string
}

function copiesOutput(copies: RemoteCopyFixture[]): string {
  return copies.map(copy => [
    `__DSH_COPY__${copy.name}`,
    `__DSH_DIR__${copy.dir}`,
    `__DSH_ENTRY__${copy.entry ?? ''}`,
    '__DSH_PKG_BEGIN__',
    copy.pkg ?? '',
    '__DSH_PKG_END__',
  ].join('\n')).join('\n')
}

function sessionWithRemote(copies: RemoteCopyFixture[], profilesResult: RemoteExecResult = { code: 0, stdout: '', stderr: '' }, extra?: (command: string) => RemoteExecResult | undefined): RemoteSession {
  return {
    exec: vi.fn(async (command: string, _options?: RemoteExecOptions): Promise<RemoteExecResult> => {
      if (command.includes('.dsh/profiles'))
        return profilesResult
      const extraResult = extra?.(command)
      if (extraResult !== undefined)
        return extraResult
      if (command.includes('DEPS="$ROOT/dependencies"'))
        return { code: 0, stdout: copiesOutput(copies), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }),
    stream: vi.fn(),
    onClosed: vi.fn(),
    close: vi.fn(async () => {}),
  }
}

async function expectProfileDirectoryUnreadable(mode: number): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-core-profiles-'))
  const profiles = join(home, '.dsh', 'profiles')
  mkdirSync(profiles, { recursive: true })
  const shellSession: RemoteSession = {
    exec: async (command) => {
      const result = spawnSync('sh', ['-c', command], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
      })
      return { code: result.status, stdout: result.stdout, stderr: result.stderr }
    },
    stream: vi.fn(),
    onClosed: vi.fn(),
    close: vi.fn(async () => {}),
  }
  vi.mocked(machine.openSession).mockResolvedValue(shellSession)

  try {
    chmodSync(profiles, mode)
    await expect(core.listProfiles(machineId)).rejects.toThrow('REMOTE_CORE_PROFILES_UNREADABLE')
  }
  finally {
    chmodSync(profiles, 0o700)
    rmSync(home, { recursive: true, force: true })
  }
}

beforeEach(() => {
  vi.mocked(machine.profileName).mockReturnValue('remote')
  listGithubReleases.mockResolvedValue([])
  listGithubAssets.mockResolvedValue([])
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('remote core contract', () => {
  it('lists remote profiles and marks the configured profile', async () => {
    const session = sessionWithRemote([], { code: 0, stdout: 'web\nremote\ninvalid.name\nweb\n', stderr: '' })
    vi.mocked(machine.openSession).mockResolvedValue(session)

    await expect(core.listProfiles(machineId)).resolves.toEqual([
      { name: 'remote', configured: true },
      { name: 'web', configured: false },
    ])
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('reports an unreadable profile directory instead of claiming no profiles', async () => {
    const session = sessionWithRemote([], { code: 1, stdout: '', stderr: 'permission denied' })
    vi.mocked(machine.openSession).mockResolvedValue(session)

    await expect(core.listProfiles(machineId)).rejects.toThrow('REMOTE_CORE_PROFILES_UNREADABLE')
    expect(session.close).toHaveBeenCalledOnce()
  })

  it.skipIf(!canTestUnixDirectoryMode)('reports a real profile directory without search access as unreadable', async () => {
    await expectProfileDirectoryUnreadable(0o400)
  })

  it.skipIf(!canTestUnixDirectoryMode)('reports a real profile directory without read access as unreadable', async () => {
    await expectProfileDirectoryUnreadable(0o300)
  })

  it('lists only valid releases that meet the remote minimum version and orders them by version', async () => {
    listGithubReleases.mockResolvedValue([
      { tag: 'dsh-0.2.1-1', prerelease: false },
      { tag: 'dsh-0.2.2-rc.1-43078653398', prerelease: true },
      { tag: 'dsh-0.2.2-43000000000', prerelease: false },
      { tag: 'v0.2.3-1', prerelease: false },
      { tag: 'dsh-0.2.3-beta.1-42', prerelease: false },
    ])

    await expect(core.listVersions()).resolves.toEqual([
      { version: '0.2.3-beta.1', tag: 'dsh-0.2.3-beta.1-42', preview: true },
      { version: '0.2.2', tag: 'dsh-0.2.2-43000000000', preview: false },
      { version: '0.2.2-rc.1', tag: 'dsh-0.2.2-rc.1-43078653398', preview: true },
    ])
  })

  it('keeps one row per version when several tags share it', async () => {
    listGithubReleases.mockResolvedValue([
      { tag: 'dsh-0.2.2-rc.1-43078653398', prerelease: true },
      { tag: 'dsh-0.2.2-rc.1-43048423223', prerelease: true },
    ])

    await expect(core.listVersions()).resolves.toEqual([
      { version: '0.2.2-rc.1', tag: 'dsh-0.2.2-rc.1-43048423223', preview: true },
    ])
  })

  it('maps the installed remote package to the neutral core target', async () => {
    const session = sessionWithRemote([{
      name: 'dsh',
      dir: '/home/remote/.dsh-desktop/dependencies/dsh',
      entry: entryPath,
      pkg: JSON.stringify({ version: '0.2.2-rc.1' }),
    }])
    vi.mocked(machine.openSession).mockResolvedValue(session)

    await expect(core.resolve(machineId)).resolves.toEqual({
      id: 'remote:remote-core-test:remote',
      scope: 'remote',
      machineId,
      remoteProfile: 'remote',
      capabilities: ['listVersions', 'installVersion'],
      platforms: ['linux-x64', 'linux-arm64', 'macos-x64'],
      availability: 'present',
      slots: [{
        kind: 'installed',
        slotKey: 'dsh',
        version: '0.2.2-rc.1',
        path: entryPath,
        dir: '/home/remote/.dsh-desktop/dependencies/dsh',
        active: true,
        removable: false,
        preview: true,
      }],
    })
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('lists downloaded copies next to the one in use', async () => {
    const session = sessionWithRemote([
      {
        name: 'dsh',
        dir: '/home/remote/.dsh-desktop/dependencies/dsh',
        entry: entryPath,
        pkg: JSON.stringify({ version: '0.2.2-rc.1' }),
      },
      {
        name: 'dsh-0.2.3-43000000000',
        dir: '/home/remote/.dsh-desktop/dependencies/dsh-0.2.3-43000000000',
        entry: '/home/remote/.dsh-desktop/dependencies/dsh-0.2.3-43000000000/node_modules/@deepseek-ai/dsh/lib/bin.js',
        pkg: JSON.stringify({ version: '0.2.3' }),
      },
    ])
    vi.mocked(machine.openSession).mockResolvedValue(session)

    await expect(core.resolve(machineId)).resolves.toMatchObject({
      availability: 'present',
      slots: [
        { kind: 'installed', slotKey: 'dsh', version: '0.2.2-rc.1', active: true, removable: false },
        {
          kind: 'installed',
          slotKey: 'dsh-0.2.3-43000000000',
          tag: 'dsh-0.2.3-43000000000',
          version: '0.2.3',
          dir: '/home/remote/.dsh-desktop/dependencies/dsh-0.2.3-43000000000',
          active: false,
          removable: true,
          preview: false,
        },
      ],
    })
  })

  it('reports an installed version below the minimum without hiding the target', async () => {
    const session = sessionWithRemote([{
      name: 'dsh',
      dir: '/home/remote/.dsh-desktop/dependencies/dsh',
      entry: entryPath,
      pkg: JSON.stringify({ version: '0.2.1' }),
    }])
    vi.mocked(machine.openSession).mockResolvedValue(session)

    await expect(core.resolve(machineId)).resolves.toMatchObject({
      availability: 'present',
      slots: [{
        kind: 'unsupported',
        slotKey: 'dsh',
        version: '0.2.1',
        error: 'REMOTE_DSH_VERSION_UNSUPPORTED: DSH 0.2.1 不受支持，最低版本 0.2.2-rc.1；请先升级远端内核',
      }],
    })
  })

  it('reports unreadable package metadata instead of absent when the copy exists', async () => {
    const session = sessionWithRemote([{
      name: 'dsh',
      dir: '/home/remote/.dsh-desktop/dependencies/dsh',
      entry: entryPath,
      pkg: 'not json',
    }])
    vi.mocked(machine.openSession).mockResolvedValue(session)

    await expect(core.resolve(machineId)).resolves.toMatchObject({
      availability: 'unreadable',
      path: entryPath,
      error: expect.stringContaining('REMOTE_DSH_PACKAGE_INVALID'),
      slots: [],
    })
  })

  it('returns absent only when the machine has no core copy at all', async () => {
    const session = sessionWithRemote([])
    vi.mocked(machine.openSession).mockResolvedValue(session)

    await expect(core.resolve(machineId)).resolves.toMatchObject({
      availability: 'absent',
      slots: [],
    })
  })

  it('reports an unknown state when the remote cannot be inspected', async () => {
    const session = sessionWithRemote([], { code: 0, stdout: '', stderr: '' }, command =>
      command.includes('DEPS="$ROOT/dependencies"')
        ? { code: 255, stdout: '', stderr: 'connection closed' }
        : undefined)
    vi.mocked(machine.openSession).mockResolvedValue(session)

    await expect(core.resolve(machineId)).resolves.toMatchObject({
      availability: 'unreadable',
      error: expect.stringContaining('REMOTE_DSH_STATE_UNKNOWN'),
      slots: [],
    })
  })

  it('downloads a version into its own directory and reports the task result', async () => {
    listGithubAssets.mockResolvedValue([{
      name: 'deepseek-harness-pkg-linux.zip',
      url: 'https://example.test/dsh.zip',
      digest: 'sha256:aaaa',
    }])
    const scripts: string[] = []
    const session = sessionWithRemote([], { code: 0, stdout: '', stderr: '' }, (command) => {
      if (command === 'uname -srm')
        return { code: 0, stdout: 'Linux 6.1.0 x86_64', stderr: '' }
      scripts.push(command)
      return { code: 0, stdout: '::dsh install dsh 安装完成 (dsh-0.2.3-43000000000)\n', stderr: '' }
    })
    vi.mocked(machine.openSession).mockResolvedValue(session)

    const accepted = await core.installVersion(machineId, 'dsh-0.2.3-43000000000')
    expect(accepted.taskId).toBeTypeOf('string')

    await vi.waitFor(() => {
      expect(tasks.since(accepted.taskId!).events.some(event => event.terminal === 'success')).toBe(true)
    })
    const events = tasks.since(accepted.taskId!).events
    expect(events.at(-1)?.line).toContain('已下载核心版本 dsh-0.2.3-43000000000')
    const script = scripts.at(-1) ?? ''
    expect(script).toContain('SLOT="$ROOT/dependencies/dsh-0.2.3-43000000000"')
    expect(script).toContain('https://example.test/dsh.zip')
  })

  it('refuses a version directory name that could escape the dependencies root', async () => {
    await expect(core.installVersion(machineId, '../escape')).rejects.toThrow('REMOTE_CORE_SLOT_INVALID')
  })

  it('reports a failed download through the task events', async () => {
    listGithubAssets.mockResolvedValue([{
      name: 'deepseek-harness-pkg-linux.zip',
      url: 'https://example.test/dsh.zip',
      digest: 'sha256:aaaa',
    }])
    const session = sessionWithRemote([], { code: 0, stdout: '', stderr: '' }, (command) => {
      if (command === 'uname -srm')
        return { code: 0, stdout: 'Linux 6.1.0 x86_64', stderr: '' }
      return { code: 10, stdout: '', stderr: 'all sources failed' }
    })
    vi.mocked(machine.openSession).mockResolvedValue(session)

    const accepted = await core.installVersion(machineId, 'dsh-0.2.3-43000000000')
    await vi.waitFor(() => {
      expect(tasks.since(accepted.taskId!).events.some(event => event.terminal === 'failed')).toBe(true)
    })
    const failed = tasks.since(accepted.taskId!).events.find(event => event.terminal === 'failed')
    expect(failed?.reason).toContain('REMOTE_CORE_INSTALL_FAILED')
  })

  it('reports a release that is no longer downloadable before the download starts', async () => {
    listGithubAssets.mockResolvedValue([])
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }))
    const session = sessionWithRemote([], { code: 0, stdout: '', stderr: '' }, (command) => {
      if (command === 'uname -srm')
        return { code: 0, stdout: 'Linux 6.1.0 x86_64', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    vi.mocked(machine.openSession).mockResolvedValue(session)

    const accepted = await core.installVersion(machineId, 'dsh-0.2.3-43000000000')
    await vi.waitFor(() => {
      expect(tasks.since(accepted.taskId!).events.some(event => event.terminal === 'failed')).toBe(true)
    })
    const failed = tasks.since(accepted.taskId!).events.find(event => event.terminal === 'failed')
    expect(failed?.reason).toContain('REMOTE_DSH_RELEASE_UNAVAILABLE')
    vi.unstubAllGlobals()
  })
})
