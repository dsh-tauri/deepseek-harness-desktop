import type { Config } from '../config/schema'
import type { MachineProfile, RemoteExecResult, RemoteSession } from '../types/index'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MachineId } from '../types/index'
import { ensureRemoteInstance } from './bootstrap.utils'

const profile: MachineProfile = { id: MachineId('listener'), name: 'listener', host: 'fixture.invalid', port: 22, user: 'fixture', remotePort: 3080 }
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
const ok = (stdout: string): RemoteExecResult => ({ code: 0, stdout, stderr: '' })
const bootHtml = (version?: unknown) => `<script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ entries: [{ url: '/plugins/layout/client.js' }], ...version === undefined ? {} : { release: { version } } })};</script>`
const snapshot = (args = ['/usr/bin/node', '/opt/dsh/lib/bin.js'], os = 'Linux') => `${os}\n424242\n/opt/work\n123 456\n${os === 'Linux' ? `${args.join('\0')}\0` : args.join(' ')}`

function sessionFor(respond: (command: string) => RemoteExecResult | Promise<RemoteExecResult>): RemoteSession & { commands: string[] } {
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

function servingSession(html: string, packageVersion = '0.2.1-rc.4', name = '@deepseek-ai/dsh', identity = snapshot()) {
  return sessionFor((command) => {
    if (command.includes('REMOTE_DSH_LISTENER_PACKAGE'))
      return ok(JSON.stringify({ name, version: packageVersion }))
    if (command.includes('REMOTE_DSH_LISTENER_PID'))
      return ok(identity)
    if (command.includes('REMOTE_DSH_PACKAGE'))
      throw new Error('unrelated managed tree must not be read')
    if (command.includes('-w'))
      return ok('export const ready = true\n200')
    return ok(html)
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('actual remote listener admission', () => {
  it('rejects an old serving release even when the managed tree could be new', async () => {
    const session = servingSession(bootHtml('0.1.7-rc.0'), '0.2.1-rc.4')
    await expect(ensureRemoteInstance(session, profile, config)).rejects.toThrow(/REMOTE_DSH_VERSION_UNSUPPORTED/)
    expect(session.commands).toHaveLength(1)
  })

  it('admits a supported serving release without reading an unrelated old managed tree', async () => {
    const session = servingSession(bootHtml('0.2.1-rc.4'), '0.1.2-rc.1')
    await expect(ensureRemoteInstance(session, profile, config)).resolves.toBe('fixture.invalid:3080')
    expect(session.commands).toHaveLength(2)
    expect(session.commands.some(command => command.includes('REMOTE_DSH_PACKAGE'))).toBe(false)
  })

  it.each(['', 123, null])('rejects an invalid explicit boot release %s rather than using another package', async (version) => {
    const session = servingSession(bootHtml(version))
    await expect(ensureRemoteInstance(session, profile, config)).rejects.toThrow(/REMOTE_DSH_VERSION_UNSUPPORTED/)
  })

  it.each(['Linux', 'Darwin'])('admits the floor graph without release only with the actual %s listener package', async (os) => {
    const session = servingSession(bootHtml(), '0.2.1-rc.4', '@deepseek-ai/dsh', snapshot(undefined, os))
    await expect(ensureRemoteInstance(session, profile, config)).resolves.toBe('fixture.invalid:3080')
    expect(session.commands.filter(command => command.includes('REMOTE_DSH_LISTENER_PID'))).toHaveLength(2)
    expect(session.commands.some(command => command.includes('--version'))).toBe(false)
  })

  it.each(['0.1.2-rc.1', '0.1.7-rc.0'])('rejects an old actual listener %s despite an otherwise healthy graph', async (version) => {
    const session = servingSession(bootHtml(), version)
    await expect(ensureRemoteInstance(session, profile, config)).rejects.toThrow(/REMOTE_DSH_VERSION_UNSUPPORTED/)
    expect(session.commands.some(command => command.includes('dsh-remote.pid'))).toBe(false)
  })

  it('does not borrow a version from a non-DSH package', async () => {
    const session = servingSession(bootHtml(), '0.2.1-rc.1', 'another-package')
    await expect(ensureRemoteInstance(session, profile, config)).rejects.toThrow(/REMOTE_DSH_VERSION_UNVERIFIABLE/)
  })

  it.each([
    snapshot(['/usr/bin/python', '/opt/dsh/lib/bin.js']),
    snapshot(['/usr/bin/node', '--eval', 'require("/opt/dsh/lib/bin.js")']),
    'Linux\n\n/opt/work\n123 456\nnode\0/opt/dsh/lib/bin.js\0',
    'Linux\n424242 424243\n/opt/work\n123 456\nnode\0/opt/dsh/lib/bin.js\0',
  ])('rejects missing/ambiguous PID or unknown process argv without reading another package', async (identity) => {
    const session = servingSession(bootHtml(), '0.2.1-rc.1', '@deepseek-ai/dsh', identity)
    await expect(ensureRemoteInstance(session, profile, config)).rejects.toThrow(/REMOTE_DSH_VERSION_UNVERIFIABLE/)
    expect(session.commands.some(command => command.includes('REMOTE_DSH_LISTENER_PACKAGE'))).toBe(false)
  })

  it.each(['TOOLS_MISSING', 'MISSING', 'MULTIPLE', 'COMMAND_UNREADABLE'])('fails once when listener identity is %s, without modifying the host', async (reason) => {
    const session = sessionFor(command => command.includes('REMOTE_DSH_LISTENER_PID')
      ? { code: 1, stdout: '', stderr: `REMOTE_DSH_LISTENER_${reason}` }
      : ok(bootHtml()))
    await expect(ensureRemoteInstance(session, profile, config)).rejects.toThrow(/REMOTE_DSH_VERSION_UNVERIFIABLE/)
    expect(session.commands).toHaveLength(2)
    expect(session.commands.some(command => /kill|trap cleanup EXIT|dsh-remote.pid/u.test(command))).toBe(false)
  })

  it('binds a relative script to the listener cwd', async () => {
    const session = servingSession(bootHtml(), '0.2.1-rc.4', '@deepseek-ai/dsh', snapshot(['/usr/bin/node', './dsh/lib/bin.js']))
    await expect(ensureRemoteInstance(session, profile, config)).resolves.toBe('fixture.invalid:3080')
    const metadata = session.commands.find(command => command.includes('REMOTE_DSH_LISTENER_PACKAGE')) ?? ''
    expect(metadata).toContain('REMOTE_DSH_LISTENER_ENTRY=\'./dsh/lib/bin.js\'')
    expect(metadata).toContain('/opt/work')
  })

  it('does not admit an unknown auth fence using an unrelated managed runtime', async () => {
    const session = sessionFor((command) => {
      if (command.includes('REMOTE_DSH_LISTENER_PID'))
        return { code: 1, stdout: '', stderr: 'REMOTE_DSH_LISTENER_MISSING' }
      if (command.includes('-w'))
        return ok('401')
      if (command.includes('REMOTE_DSH_PACKAGE'))
        throw new Error('must not use managed metadata')
      return ok('<html>authentication required</html>')
    })
    await expect(ensureRemoteInstance(session, profile, config)).rejects.toThrow(/REMOTE_DSH_VERSION_UNVERIFIABLE/)
  })

  it('admits a supported auth fence only from the actual listener package', async () => {
    const session = sessionFor((command) => {
      if (command.includes('REMOTE_DSH_LISTENER_PACKAGE'))
        return ok('{"name":"@deepseek-ai/dsh","version":"0.2.1-rc.4"}')
      if (command.includes('REMOTE_DSH_LISTENER_PID'))
        return ok(snapshot())
      if (command.includes('-w'))
        return ok('401')
      return ok('<html>authentication required</html>')
    })
    await expect(ensureRemoteInstance(session, profile, config)).resolves.toBe('fixture.invalid:3080')
  })

  it('accepts a global dsh symlink entry before resolving its package', async () => {
    const session = servingSession(bootHtml(), '0.2.1-rc.4', '@deepseek-ai/dsh', snapshot(['/usr/bin/node', '/usr/local/bin/dsh']))
    await expect(ensureRemoteInstance(session, profile, config)).resolves.toBe('fixture.invalid:3080')
    const metadata = session.commands.find(command => command.includes('REMOTE_DSH_LISTENER_PACKAGE')) ?? ''
    expect(metadata).toContain('while [ -L "$REMOTE_DSH_LISTENER_ENTRY" ]')
    expect(metadata).toContain('case "$REMOTE_DSH_LISTENER_ENTRY" in */lib/bin.js)')
    expect(metadata).toContain('REMOTE_DSH_LISTENER_ENTRY=\'/usr/local/bin/dsh\'')
  })

  it.each([
    { entry: 'dsh/lib/bin.js', name: '@deepseek-ai/dsh', accepted: true },
    { entry: 'other/lib/bin.js', name: 'another-package', accepted: false },
    { entry: 'other/server.js', name: '@deepseek-ai/dsh', accepted: false },
  ])('checks the canonical entry and package in an isolated shell: $entry ($name)', async ({ entry, name, accepted }) => {
    const sandbox = mkdtempSync(join(tmpdir(), 'dsh-listener-'))
    const shellPath = (path: string) => process.platform === 'win32'
      ? path.replaceAll('\\', '/').replace(/^([A-Z]):/iu, (_, drive: string) => `/${drive.toLowerCase()}`)
      : path
    try {
      const bin = join(sandbox, entry)
      mkdirSync(dirname(bin), { recursive: true })
      writeFileSync(bin, '')
      writeFileSync(join(sandbox, entry.split('/')[0]!, 'package.json'), JSON.stringify({ name, version: '0.2.1-rc.4' }))
      const identity = `Linux\n424242\n${shellPath(sandbox)}\n123 456\n/usr/bin/node\0./${entry}\0`
      const session = sessionFor(async (command) => {
        if (command.includes('REMOTE_DSH_LISTENER_PACKAGE')) {
          const script = join(sandbox, 'probe.sh')
          writeFileSync(script, command)
          return promisify(execFile)(process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash', [shellPath(script)], { cwd: sandbox, env: { ...process.env, HOME: sandbox } }).then(
            result => ok(result.stdout),
            (error: { code?: number, stdout?: string, stderr?: string }) => ({ code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
          )
        }
        if (command.includes('REMOTE_DSH_LISTENER_PID'))
          return ok(identity)
        return command.includes('-w') ? ok('export const ready = true\n200') : ok(bootHtml())
      })
      const result = ensureRemoteInstance(session, profile, config)
      if (accepted)
        await expect(result).resolves.toBe('fixture.invalid:3080')
      else
        await expect(result).rejects.toThrow(/REMOTE_DSH_VERSION_UNVERIFIABLE/)
    }
    finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('starts a custom command without provisioning or checking an unrelated managed tree', async () => {
    const fetch = vi.fn(() => {
      throw new Error('must not fetch')
    })
    vi.stubGlobal('fetch', fetch)
    let started = false
    const session = sessionFor((command) => {
      if (command.includes('fixture-custom-start')) {
        started = true
        return ok('')
      }
      if (command.includes('REMOTE_DSH_PACKAGE') || command.includes('echo node') || command === 'uname -srm')
        throw new Error('managed provisioning must not run')
      if (command.includes('-w'))
        return ok('export const ready = true\n200')
      return started ? ok(bootHtml('0.2.1-rc.4')) : { code: 7, stdout: '', stderr: 'not running' }
    })
    await expect(ensureRemoteInstance(session, { ...profile, startCommand: 'fixture-custom-start' }, config)).resolves.toBe('fixture.invalid:3080')
    expect(started).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })
})
