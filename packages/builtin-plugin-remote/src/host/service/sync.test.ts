import type { RemoteExecOptions, RemoteExecResult, RemoteSession } from '../types/index'
import type { SyncDeps } from './sync.types'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearHostRuntime, setSyncDeps } from '../config/runtime'
import { MachineId } from '../types/index'
import { packSkills } from '../utils/local'
import { machine } from './machine'
import { sync } from './sync'

vi.mock('dsh-tauri', () => ({ defineService: <T>(service: T): T => service }))
vi.mock('./machine', () => ({
  machine: {
    syncProfiles: vi.fn(async () => {}),
    profileName: vi.fn(() => 'web'),
    openSession: vi.fn(),
    setProgress: vi.fn(),
    localAllowlist: vi.fn(() => ({ allowBuilds: {}, onlyBuiltDependencies: [] })),
  },
}))

const machineId = MachineId('sync-test')
let home: string
let deps: SyncDeps
let session: RemoteSession

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

async function exec(command: string, options?: RemoteExecOptions): Promise<RemoteExecResult> {
  if (options?.stdinData !== undefined) {
    const result = spawnSync('sh', ['-c', command], {
      input: options.stdinData,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      timeout: 5000,
    })
    if (result.error !== undefined)
      throw result.error
    return { code: result.status, stdout: result.stdout, stderr: result.stderr }
  }
  if (command.includes('REMOTE_DSH_PACKAGE'))
    return { code: 0, stdout: JSON.stringify({ version: '0.2.1-rc.5' }), stderr: '' }
  if (command.includes('printf \'%s\\n\''))
    return { code: 0, stdout: '/remote/dsh/bin.js\n', stderr: '' }
  return { code: 0, stdout: '', stderr: '' }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-remote-sync-'))
  deps = { profileDependencies: () => ({}), scanSkills: () => [], packSkills }
  setSyncDeps(deps)
  session = {
    exec: vi.fn(exec),
    stream: vi.fn(),
    onClosed: vi.fn(),
    close: vi.fn(async () => {}),
  }
  vi.mocked(machine.openSession).mockResolvedValue(session)
})

afterEach(() => {
  clearHostRuntime()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

describe('remote selection sync', () => {
  it('installs distinct npm packages with the same version range exactly once each', async () => {
    const one = { name: 'plugin-one', spec: '^1.0.0' }
    const two = { name: 'plugin-two', spec: '^1.0.0' }

    const result = await sync.apply(machineId, [one, two, one], [])

    expect(result.items).toEqual([
      { kind: 'plugin', name: 'plugin-one', ok: true },
      { kind: 'plugin', name: 'plugin-two', ok: true },
    ])
    const commands = vi.mocked(session.exec).mock.calls.map(([command]) => command).filter(command => command.includes(' plugin '))
    expect(commands).toHaveLength(2)
    expect(commands[0]).toContain('add \'plugin-one@^1.0.0\'')
    expect(commands[1]).toContain('add \'plugin-two@^1.0.0\'')
  })

  it.each([
    ['shared', 'shared'],
    ['Foo', 'foo'],
    ['caf\u00E9', 'cafe\u0301'],
  ])('rejects conflicting skill names %j and %j before any remote work', async (first, second) => {
    await expect(sync.apply(machineId, [{ name: 'plugin-one', spec: 'latest' }], [
      { root: 'dsh', name: first },
      { root: 'agents', name: second },
    ])).rejects.toThrow(/select only one.*root/i)

    expect(machine.syncProfiles).not.toHaveBeenCalled()
    expect(machine.openSession).not.toHaveBeenCalled()
    expect(session.exec).not.toHaveBeenCalled()
  })

  it.each(['', '.', '..', '../escape', 'nested/skill', 'nested\\skill', 'skill\0name'])('rejects unsafe skill name %j before any remote work', async (name) => {
    await expect(sync.apply(machineId, [], [{ root: 'dsh', name }])).rejects.toThrow('invalid skill name')

    expect(machine.syncProfiles).not.toHaveBeenCalled()
    expect(machine.openSession).not.toHaveBeenCalled()
  })

  it('replaces the selected skill directory without retaining deleted files', async () => {
    const local = join(home, 'local-skills')
    const target = join(home, '.dsh', 'skills')
    write(join(local, 'example', 'SKILL.md'), 'new version')
    write(join(local, 'example', 'new-script.sh'), 'new script')
    write(join(target, 'example', 'SKILL.md'), 'old version')
    write(join(target, 'example', 'old-script.sh'), 'obsolete script')
    write(join(target, 'unselected', 'SKILL.md'), 'keep this skill')
    deps.scanSkills = () => [{ root: 'dsh', dir: local, names: ['example'] }]

    const result = await sync.apply(machineId, [], [{ root: 'dsh', name: 'example' }, { root: 'dsh', name: 'example' }])

    expect(result.items).toEqual([{ kind: 'skill', root: 'dsh', name: 'example', ok: true }])
    expect(readFileSync(join(target, 'example', 'SKILL.md'), 'utf8')).toBe('new version')
    expect(readFileSync(join(target, 'example', 'new-script.sh'), 'utf8')).toBe('new script')
    expect(existsSync(join(target, 'example', 'old-script.sh'))).toBe(false)
    expect(readFileSync(join(target, 'unselected', 'SKILL.md'), 'utf8')).toBe('keep this skill')
    expect(readdirSync(target).sort()).toEqual(['example', 'unselected'])
    expect(existsSync(join(home, '.dsh', '.skills-sync.lock'))).toBe(false)
  })

  it('preserves existing skill files when the received archive cannot be extracted', async () => {
    const target = join(home, '.dsh', 'skills', 'example')
    write(join(target, 'SKILL.md'), 'original')
    write(join(target, 'script.sh'), 'original script')
    deps.scanSkills = () => [{ root: 'agents', dir: join(home, 'local'), names: ['example'] }]
    deps.packSkills = async () => Buffer.from('not a tar archive')

    const result = await sync.apply(machineId, [], [{ root: 'agents', name: 'example' }])

    expect(result.items).toEqual([expect.objectContaining({ kind: 'skill', root: 'agents', name: 'example', ok: false })])
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('original')
    expect(readFileSync(join(target, 'script.sh'), 'utf8')).toBe('original script')
    expect(readdirSync(dirname(target))).toEqual(['example'])
    expect(existsSync(join(home, '.dsh', '.skills-sync.lock'))).toBe(false)
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('transfers distinct skill names from both roots without interpreting shell characters', async () => {
    const dsh = join(home, 'local-dsh')
    const agents = join(home, 'local-agents')
    const name = 'skill\'s $(echo Injected)'
    write(join(dsh, name, 'SKILL.md'), 'quoted name')
    write(join(agents, 'second', 'SKILL.md'), 'agents skill')
    deps.scanSkills = () => [
      { root: 'dsh', dir: dsh, names: [name] },
      { root: 'agents', dir: agents, names: ['second'] },
    ]

    const result = await sync.apply(machineId, [], [{ root: 'dsh', name }, { root: 'agents', name: 'second' }])

    expect(result.items).toEqual([
      { kind: 'skill', root: 'dsh', name, ok: true },
      { kind: 'skill', root: 'agents', name: 'second', ok: true },
    ])
    const target = join(home, '.dsh', 'skills')
    expect(readFileSync(join(target, name, 'SKILL.md'), 'utf8')).toBe('quoted name')
    expect(readFileSync(join(target, 'second', 'SKILL.md'), 'utf8')).toBe('agents skill')
    expect(readdirSync(target).sort()).toEqual(['second', name])
  })

  it('preserves the previous directory when publishing the staged skill fails', async () => {
    const local = join(home, 'local-skills')
    const target = join(home, '.dsh', 'skills', 'example')
    write(join(local, 'example', 'SKILL.md'), 'new version')
    write(join(target, 'SKILL.md'), 'original')
    write(join(target, 'script.sh'), 'original script')
    deps.scanSkills = () => [{ root: 'dsh', dir: local, names: ['example'] }]
    vi.mocked(session.exec).mockImplementation(async (command, options) => {
      const rejectPublish = 'mv() { case "$1" in */incoming/*) return 1 ;; *) command mv "$@" ;; esac; }\n'
      return exec(rejectPublish + command, options)
    })

    const result = await sync.apply(machineId, [], [{ root: 'dsh', name: 'example' }])

    expect(result.items).toEqual([expect.objectContaining({ kind: 'skill', root: 'dsh', name: 'example', ok: false })])
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('original')
    expect(readFileSync(join(target, 'script.sh'), 'utf8')).toBe('original script')
    expect(readdirSync(dirname(target))).toEqual(['example'])
    expect(existsSync(join(home, '.dsh', '.skills-sync.lock'))).toBe(false)
  })

  it('rejects a concurrent skill sync without releasing its lock or changing existing files', async () => {
    const local = join(home, 'local-skills')
    const target = join(home, '.dsh', 'skills', 'example')
    const lock = join(home, '.dsh', '.skills-sync.lock')
    write(join(local, 'example', 'SKILL.md'), 'new version')
    write(join(target, 'SKILL.md'), 'original')
    mkdirSync(lock)
    deps.scanSkills = () => [{ root: 'dsh', dir: local, names: ['example'] }]

    const result = await sync.apply(machineId, [], [{ root: 'dsh', name: 'example' }])

    expect(result.items).toEqual([expect.objectContaining({
      kind: 'skill',
      root: 'dsh',
      name: 'example',
      ok: false,
      error: expect.stringContaining('Another skill sync is active'),
    })])
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('original')
    expect(existsSync(lock)).toBe(true)
    expect(readdirSync(dirname(target))).toEqual(['example'])
  })

  it('retains the backup with a recovery path when publishing and rollback both fail', async () => {
    const local = join(home, 'local-skills')
    const target = join(home, '.dsh', 'skills', 'example')
    write(join(local, 'example', 'SKILL.md'), 'new version')
    write(join(target, 'SKILL.md'), 'original')
    deps.scanSkills = () => [{ root: 'dsh', dir: local, names: ['example'] }]
    vi.mocked(session.exec).mockImplementation(async (command, options) => {
      const rejectPublishAndRollback = 'mv() { case "$1" in */incoming/*|*/previous/*) return 1 ;; *) command mv "$@" ;; esac; }\n'
      return exec(rejectPublishAndRollback + command, options)
    })

    const result = await sync.apply(machineId, [], [{ root: 'dsh', name: 'example' }])

    const stages = readdirSync(dirname(target)).filter(name => name.startsWith('.dsh-sync.'))
    expect(stages).toHaveLength(1)
    const backup = join(dirname(target), stages[0]!, 'previous', 'example')
    expect(result.items).toEqual([expect.objectContaining({
      kind: 'skill',
      root: 'dsh',
      name: 'example',
      ok: false,
      error: expect.stringContaining(backup),
    })])
    expect(readFileSync(join(backup, 'SKILL.md'), 'utf8')).toBe('original')
    expect(existsSync(join(home, '.dsh', '.skills-sync.lock'))).toBe(false)
  })
})
