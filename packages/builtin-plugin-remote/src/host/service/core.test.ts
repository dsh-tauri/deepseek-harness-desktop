import type { RemoteExecOptions, RemoteExecResult, RemoteSession } from '../types/index'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MachineId } from '../types/index'
import { core } from './core'
import { machine } from './machine'

const listGithubReleases = vi.hoisted(() => vi.fn())

vi.mock('dsh-tauri', () => ({ defineService: <T>(service: T): T => service }))
vi.mock('../config/runtime', () => ({ hostConfig: () => ({ installRepo: undefined }) }))
vi.mock('../utils/version', async importOriginal => ({
  ...await importOriginal<typeof import('../utils/version')>(),
  listGithubReleases,
}))
vi.mock('./machine', () => ({
  machine: {
    openSession: vi.fn(),
    profileName: vi.fn(),
  },
}))

const machineId = MachineId('remote-core-test')
let session: RemoteSession
const entryPath = '/home/remote/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'

function sessionWithRemote(packageResult: RemoteExecResult, entryResult: RemoteExecResult, profilesResult: RemoteExecResult = { code: 0, stdout: '', stderr: '' }): RemoteSession {
  return {
    exec: vi.fn(async (command: string, _options?: RemoteExecOptions): Promise<RemoteExecResult> => {
      if (command.includes('.dsh/profiles'))
        return profilesResult
      return command.includes('REMOTE_DSH_PACKAGE') ? packageResult : entryResult
    }),
    stream: vi.fn(),
    onClosed: vi.fn(),
    close: vi.fn(async () => {}),
  }
}

beforeEach(() => {
  vi.mocked(machine.profileName).mockReturnValue('remote')
  listGithubReleases.mockResolvedValue([])
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('remote core contract', () => {
  it('lists remote profiles and marks the configured profile', async () => {
    session = sessionWithRemote(
      { code: 0, stdout: 'REMOTE_DSH_MISSING', stderr: '' },
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: 'web\nremote\ninvalid.name\nweb\n', stderr: '' },
    )
    vi.mocked(machine.openSession).mockResolvedValue(session)

    await expect(core.listProfiles(machineId)).resolves.toEqual([
      { name: 'remote', configured: true },
      { name: 'web', configured: false },
    ])
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('reports an unreadable profile directory instead of claiming no profiles', async () => {
    session = sessionWithRemote(
      { code: 0, stdout: 'REMOTE_DSH_MISSING', stderr: '' },
      { code: 0, stdout: '', stderr: '' },
      { code: 1, stdout: '', stderr: 'permission denied' },
    )
    vi.mocked(machine.openSession).mockResolvedValue(session)

    await expect(core.listProfiles(machineId)).rejects.toThrow('REMOTE_CORE_PROFILES_UNREADABLE')
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('lists only valid releases that meet the remote minimum version', async () => {
    listGithubReleases.mockResolvedValue([
      { tag: 'dsh-0.2.1-1', prerelease: false },
      { tag: 'dsh-0.2.2-rc.1-43078653398', prerelease: true },
      { tag: 'dsh-0.2.2-43000000000', prerelease: false },
      { tag: 'v0.2.3-1', prerelease: false },
      { tag: 'dsh-0.2.3-beta.1-42', prerelease: false },
    ])

    await expect(core.listVersions()).resolves.toEqual([
      { version: '0.2.2-rc.1', tag: 'dsh-0.2.2-rc.1-43078653398', preview: true },
      { version: '0.2.2', tag: 'dsh-0.2.2-43000000000', preview: false },
      { version: '0.2.3-beta.1', tag: 'dsh-0.2.3-beta.1-42', preview: true },
    ])
  })

  it('maps the installed remote package to the neutral core target', async () => {
    session = sessionWithVersion('0.2.2-rc.1')
    vi.mocked(machine.openSession).mockResolvedValue(session)

    await expect(core.resolve(machineId)).resolves.toEqual({
      id: 'remote:remote-core-test:remote',
      scope: 'remote',
      machineId,
      remoteProfile: 'remote',
      capabilities: ['listVersions'],
      platforms: ['linux-x64', 'linux-arm64', 'macos-x64'],
      availability: 'present',
      slots: [{
        kind: 'installed',
        slotKey: 'current',
        version: '0.2.2-rc.1',
        path: entryPath,
        active: true,
        preview: true,
      }],
    })
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('reports an installed version below the minimum without hiding the target', async () => {
    session = sessionWithVersion('0.2.1')
    vi.mocked(machine.openSession).mockResolvedValue(session)

    await expect(core.resolve(machineId)).resolves.toMatchObject({
      availability: 'present',
      slots: [{
        kind: 'unsupported',
        slotKey: 'current',
        version: '0.2.1',
        error: 'REMOTE_DSH_VERSION_UNSUPPORTED: DSH 0.2.1 不受支持，最低版本 0.2.2-rc.1；请先升级远端内核',
      }],
    })
  })

  it('returns absent only when both the entry probe and package metadata are cleanly missing', async () => {
    session = sessionWithRemote(
      { code: 0, stdout: 'REMOTE_DSH_MISSING', stderr: '' },
      { code: 0, stdout: '', stderr: '' },
    )
    vi.mocked(machine.openSession).mockResolvedValue(session)

    const target = await core.resolve(machineId)

    expect(target).toMatchObject({
      availability: 'absent',
      slots: [],
    })
  })

  it('reports unreadable package metadata instead of absent when the entry exists', async () => {
    session = sessionWithRemote(
      { code: 0, stdout: 'not json', stderr: '' },
      { code: 0, stdout: `${entryPath}\n`, stderr: '' },
    )
    vi.mocked(machine.openSession).mockResolvedValue(session)

    await expect(core.resolve(machineId)).resolves.toMatchObject({
      availability: 'unreadable',
      path: entryPath,
      error: expect.stringContaining('REMOTE_DSH_PACKAGE_INVALID'),
      slots: [],
    })
  })

  it('reports an unknown state when installation evidence is missing and the entry probe fails', async () => {
    session = sessionWithRemote(
      { code: 0, stdout: 'REMOTE_DSH_MISSING', stderr: '' },
      { code: 255, stdout: '', stderr: 'connection closed' },
    )
    vi.mocked(machine.openSession).mockResolvedValue(session)

    await expect(core.resolve(machineId)).resolves.toMatchObject({
      availability: 'unreadable',
      error: expect.stringContaining('REMOTE_DSH_STATE_UNKNOWN'),
      slots: [],
    })
  })

  it('does not become installed when the package read fails without an entry path', async () => {
    session = sessionWithRemote(
      { code: 1, stdout: '', stderr: 'cat failed' },
      { code: 0, stdout: '', stderr: '' },
    )
    vi.mocked(machine.openSession).mockResolvedValue(session)

    await expect(core.resolve(machineId)).resolves.toMatchObject({
      availability: 'unreadable',
      error: expect.stringContaining('REMOTE_DSH_PACKAGE_UNREADABLE'),
      slots: [],
    })
  })
})

function sessionWithVersion(version: string): RemoteSession {
  return sessionWithRemote(
    { code: 0, stdout: JSON.stringify({ version }), stderr: '' },
    { code: 0, stdout: `${entryPath}\n`, stderr: '' },
  )
}
