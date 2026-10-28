import type { Config } from '../config/schema'
import type { MachineProfile, RemoteExecResult, RemoteSession } from '../types/index'
import type { RemoteInstallPlan } from './bootstrap.types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MachineId } from '../types/index'
import { FALLBACK_DSH_TAG, RECOMMENDED_DSH_VERSION } from '../utils/version'
import { assertRemoteDshVersion, buildInstallScript, ensureRemoteInstance, planRemoteInstall, runInstallScript, startCommandFor } from './bootstrap.utils'

const profile: MachineProfile = { id: MachineId('baseline'), name: 'baseline', host: 'fixture.invalid', port: 22, user: 'fixture', remotePort: 3080 }
const config: Config = {
  connectTimeoutMs: 100,
  healthCheckTimeoutMs: 100,
  healthPollIntervalMs: 1,
  healthPollAttempts: 1,
  keepaliveIntervalMs: 100,
  keepaliveCountMax: 1,
  reconnectInitialDelayMs: 1,
  reconnectMaxDelayMs: 1,
  reconnectMaxAttempts: 1,
}
const releases = [{ tag: 'dsh-0.2.1-rc.4-40372188763', prerelease: false }]
const bootHtml = '<script>globalThis["__DSH_BOOT__"] = {"release":{"version":"0.1.7-rc.0"},"entries":[{"url":"/plugins/layout/client.js"}]};</script>'

function fetchers() {
  return {
    listReleases: vi.fn(async () => releases),
    listAssets: vi.fn(async () => []),
    npmDist: vi.fn(async () => ({ url: 'https://fixture.invalid/dsh.tgz', mirrorUrl: 'https://fixture.invalid/mirror.tgz' })),
  }
}

function fakeSession(respond: (command: string) => RemoteExecResult): RemoteSession & { commands: string[] } {
  const commands: string[] = []
  return {
    commands,
    exec: async (command) => {
      commands.push(command)
      return respond(command)
    },
    stream: async () => { throw new Error('unexpected stream') },
    close: async () => {},
    onClosed: () => {},
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('remote DSH baseline', () => {
  it('uses the manifest recommendation and verified offline fallback', async () => {
    expect(RECOMMENDED_DSH_VERSION).toBe('0.2.1-rc.4')
    expect(FALLBACK_DSH_TAG).toBe('dsh-0.2.1-rc.4-40372188763')
    const plan = await planRemoteInstall('Linux x86_64', {}, fetchers())
    expect(plan.dshVersion).toBe('0.2.1-rc.4')
    expect(plan.dsh).toMatchObject({ tag: 'dsh-0.2.1-rc.4-40372188763' })
  })

  it.each(['0.1.2-rc.1', '0.1.7-rc.1', '0.2.1-rc.3', 'dsh-0.1.6-rc.9-42', 'dsh-0.2.1-rc.3-42', 'dsh-invalid-42'])(
    'rejects unsupported pin %s before metadata requests',
    async (installRef) => {
      const mocks = fetchers()
      await expect(planRemoteInstall('Linux x86_64', { installRef }, mocks)).rejects.toThrow(/REMOTE_DSH_VERSION_UNSUPPORTED.*0\.2\.1-rc\.4/)
      expect(mocks.listReleases).not.toHaveBeenCalled()
      expect(mocks.listAssets).not.toHaveBeenCalled()
      expect(mocks.npmDist).not.toHaveBeenCalled()
    },
  )

  it.each(['0.2.1-rc.4', '0.2.1-rc.5', '0.2.1', '0.2.2-alpha.2'])(
    'admits supported prerelease boundary %s',
    async (version) => {
      const mocks = fetchers()
      mocks.listReleases.mockResolvedValue([{ tag: `dsh-${version}-42`, prerelease: false }])
      const plan = await planRemoteInstall('Linux aarch64', { installRef: version }, mocks)
      expect(plan.dshVersion).toBe(version)
      expect(mocks.npmDist).toHaveBeenCalledWith('@deepseek-ai/dsh', version)
    },
  )

  it.each(['Linux x86_64', 'Linux aarch64'])('rejects an obsolete stable resolution on %s before asset requests', async (uname) => {
    const mocks = fetchers()
    mocks.listReleases.mockResolvedValue([{ tag: 'dsh-0.1.2-rc.1-33729514615', prerelease: false }])
    await expect(planRemoteInstall(uname, {}, mocks)).rejects.toThrow(/REMOTE_DSH_VERSION_UNSUPPORTED/)
    expect(mocks.listAssets).not.toHaveBeenCalled()
    expect(mocks.npmDist).not.toHaveBeenCalled()
  })

  it('rejects stale or forged plans before any remote installation or launch', async () => {
    const valid = await planRemoteInstall('Linux x86_64', {}, fetchers())
    const stale: RemoteInstallPlan = { ...valid, dshVersion: '0.1.7-rc.0', dsh: { ...valid.dsh, tag: 'dsh-0.1.7-rc.0-42' } as RemoteInstallPlan['dsh'] }
    const session = fakeSession(() => {
      throw new Error('must not execute')
    })
    expect(() => buildInstallScript(stale)).toThrow(/REMOTE_DSH_VERSION_UNSUPPORTED/)
    expect(() => startCommandFor(profile, stale)).toThrow(/REMOTE_DSH_VERSION_UNSUPPORTED/)
    await expect(runInstallScript(session, stale, 100, {})).rejects.toThrow(/REMOTE_DSH_VERSION_UNSUPPORTED/)
    expect(session.commands).toEqual([])
  })

  it.each(['0.1.2-rc.1', '0.1.7-rc.0', 'unknown'])('does not run existing unsupported managed runtime %s', async (version) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => releases.map(item => ({ tag_name: item.tag, prerelease: false })) })))
    const session = fakeSession((command) => {
      if (command.includes('REMOTE_DSH_PACKAGE'))
        return { code: 0, stdout: JSON.stringify({ version }), stderr: '' }
      if (command === 'uname -srm')
        return { code: 0, stdout: 'Linux x86_64', stderr: '' }
      if (command.includes('echo node'))
        return { code: 0, stdout: '', stderr: '' }
      if (command.includes('dsh-remote.pid'))
        return { code: 0, stdout: '', stderr: '' }
      return { code: 7, stdout: '', stderr: '' }
    })
    const events = vi.fn()
    await expect(ensureRemoteInstance(session, profile, config, { onEvent: events })).rejects.toThrow(/REMOTE_DSH_VERSION_UNSUPPORTED/)
    expect(session.commands.some(command => command.includes('dsh-remote.pid'))).toBe(false)
    expect(session.commands.some(command => command.includes('trap cleanup EXIT'))).toBe(false)
    expect(events).toHaveBeenCalledWith('failed', 'bootstrap 失败', expect.objectContaining({ terminal: 'failed' }))
  })

  it.each(['0.2.1-rc.4', '0.2.1-rc.5', '0.2.1', '0.2.2-alpha.2'])('accepts installed package metadata at or above floor: %s', async (version) => {
    const session = fakeSession(() => ({ code: 0, stdout: JSON.stringify({ version }), stderr: '' }))
    await expect(assertRemoteDshVersion(session)).resolves.toBeUndefined()
    expect(session.commands[0]).toContain('node_modules/@deepseek-ai/dsh/package.json')
    expect(session.commands[0]).toContain('dependencies/dsh/package.json')
    expect(session.commands[0]).not.toContain('--version')
  })

  it.each(['{}', '{"version":123}', 'invalid', '{"version":"0.1.7-rc.0"}'])('rejects unreadable or unsupported installed package metadata: %s', async (stdout) => {
    const session = fakeSession(() => ({ code: 0, stdout, stderr: '' }))
    await expect(assertRemoteDshVersion(session, true)).rejects.toThrow(/REMOTE_DSH_VERSION_UNSUPPORTED/)
  })

  it('allows only a confirmed missing runtime when probing a fresh machine', async () => {
    const session = fakeSession(() => ({ code: 0, stdout: 'REMOTE_DSH_MISSING\n', stderr: '' }))
    await expect(assertRemoteDshVersion(session, true)).resolves.toBeUndefined()
    await expect(assertRemoteDshVersion(session)).rejects.toThrow(/REMOTE_DSH_VERSION_UNSUPPORTED/)
    const failed = fakeSession(() => ({ code: 1, stdout: 'REMOTE_DSH_MISSING', stderr: 'denied' }))
    await expect(assertRemoteDshVersion(failed, true)).rejects.toThrow(/REMOTE_DSH_VERSION_UNSUPPORTED/)
  })

  it('does not accept a running old managed instance even with a valid boot graph', async () => {
    const session = fakeSession((command) => {
      if (command.includes('REMOTE_DSH_PACKAGE'))
        return { code: 0, stdout: '{"version":"0.1.2-rc.1"}', stderr: '' }
      if (command.includes('-w'))
        return { code: 0, stdout: 'console.log(1)\n200', stderr: '' }
      return { code: 0, stdout: bootHtml, stderr: '' }
    })
    await expect(ensureRemoteInstance(session, profile, config)).rejects.toThrow(/REMOTE_DSH_VERSION_UNSUPPORTED/)
  })
})
