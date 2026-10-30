import type { Binding } from '../types'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ value: '' }))
vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  return { ...actual, get DSH_HOME() {
    return home.value
  } }
})

let scratch: string
let worktree: typeof import('./worktree')['worktree']
let binding: Binding
const protectedFiles = ['sessions/project/turn.json', 'profiles/web/package.json', 'storages/workspace.json', '.credentials.yaml']

beforeEach(async () => {
  vi.resetModules()
  scratch = mkdtempSync(join(tmpdir(), 'dsh-cleanup-safety-'))
  home.value = join(scratch, 'dsh-home')
  for (const name of protectedFiles) {
    const path = join(home.value, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `preserve ${name}`)
  }
  binding = {
    sessionId: 'session',
    hash: 'hash',
    dirname: 'project',
    worktreePath: join(home.value, 'worktrees/hash/project'),
    projectPath: '',
    branchName: '(detached)',
    ownsBranch: false,
  } as Binding
  ;({ worktree } = await import('./worktree'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function saveBinding() {
  const directory = join(home.value, 'ledger')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'session.json'), JSON.stringify(binding))
}

function expectProtectedData() {
  for (const name of protectedFiles) {
    const path = join(home.value, name)
    expect(existsSync(path), `cleanup must preserve ${name}`).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(`preserve ${name}`)
  }
}

function linkDirectory(target: string, link: string) {
  mkdirSync(join(link, '..'), { recursive: true })
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

describe('worktree deletion boundaries', () => {
  it.each(['home', 'sessions', 'external'])('preserves user data when a saved binding points at %s', async (target) => {
    const external = join(scratch, 'external')
    mkdirSync(external)
    writeFileSync(join(external, 'keep.txt'), 'outside data')
    binding.worktreePath = target === 'home' ? home.value : target === 'sessions' ? join(home.value, 'sessions') : external
    saveBinding()
    const result = await worktree.remove('session')
    expectProtectedData()
    expect(readFileSync(join(external, 'keep.txt'), 'utf8')).toBe('outside data')
    expect(result.ok).toBe(false)
    expect(existsSync(join(home.value, 'ledger/session.json'))).toBe(true)
  })

  it('rejects a damaged binding before scheduling asynchronous deletion', async () => {
    binding.worktreePath = home.value
    saveBinding()
    const result = await worktree.discard('session', 'hash/project')
    expect(result.ok).toBe(false)
    expectProtectedData()
  })

  it('preserves an external alias and its binding instead of reporting successful removal', async () => {
    const managed = binding.worktreePath
    mkdirSync(managed, { recursive: true })
    writeFileSync(join(managed, 'keep.txt'), 'worktree data')
    const alias = join(scratch, 'external-alias')
    linkDirectory(managed, alias)
    binding.worktreePath = alias
    saveBinding()
    const result = await worktree.remove('session')
    expect(result.ok).toBe(false)
    expect(existsSync(alias)).toBe(true)
    expect(readFileSync(join(managed, 'keep.txt'), 'utf8')).toBe('worktree data')
    expect(existsSync(join(home.value, 'ledger/session.json'))).toBe(true)
    expectProtectedData()
  })

  it.each(['..', '.. ', '', null, {}])('rejects a saved binding with malformed hash %j', async (hash) => {
    Object.assign(binding, { hash })
    mkdirSync(binding.worktreePath, { recursive: true })
    writeFileSync(join(binding.worktreePath, 'keep.txt'), 'worktree data')
    saveBinding()
    const result = await worktree.remove('session')
    expect(result.ok).toBe(false)
    expectProtectedData()
    expect(readFileSync(join(binding.worktreePath, 'keep.txt'), 'utf8')).toBe('worktree data')
  })

  it('rejects a damaged binding before checkout can change the repository', async () => {
    binding.worktreePath = home.value
    saveBinding()
    const result = await worktree.checkout({ sessionId: 'session', branch_name: 'main' })
    expect(result).toEqual({ ok: false, error: '工作树路径不安全，已保留数据' })
    expectProtectedData()
  })

  it('rejects an orphan cleanup through a worktree parent link', async () => {
    linkDirectory(home.value, join(home.value, 'worktrees/hash'))
    const result = await worktree.remove('', 'hash/sessions')
    expectProtectedData()
    expect(result.ok).toBe(false)
  })

  it('preserves sessions when a trash parent link redirects pre-deletion cleanup', async () => {
    binding.dirname = 'sessions'
    binding.worktreePath = join(home.value, 'worktrees/hash/sessions')
    mkdirSync(binding.worktreePath, { recursive: true })
    writeFileSync(join(binding.worktreePath, 'keep.txt'), 'worktree data')
    saveBinding()
    linkDirectory(home.value, join(home.value, '.trash/hash'))
    const result = await worktree.remove('session')
    expectProtectedData()
    expect(readFileSync(join(binding.worktreePath, 'keep.txt'), 'utf8')).toBe('worktree data')
    expect(result.ok).toBe(false)
  })

  it('does not sweep a trash root that redirects into DSH_HOME', async () => {
    linkDirectory(home.value, join(home.value, '.trash'))
    const result = await worktree.recover()
    expectProtectedData()
    expect(result.ok).toBe(false)
  })

  it.each(['../..', '.. /.. ', 'hash/..\\..', 'hash/C:'])('rejects unsafe orphan key %s', async (key) => {
    const result = await worktree.remove('', key)
    expect(result.ok).toBe(false)
    expectProtectedData()
  })

  it('removes an ordinary managed orphan while preserving user data', async () => {
    mkdirSync(binding.worktreePath, { recursive: true })
    writeFileSync(join(binding.worktreePath, 'remove.txt'), 'orphan worktree')
    const result = await worktree.remove('', 'hash/project')
    expect(result.ok).toBe(true)
    expect(existsSync(binding.worktreePath)).toBe(false)
    expectProtectedData()
  })

  it.each(['configured', 'canonical', 'original'])('allows a linked DSH_HOME with a %s binding path', async (pathKind) => {
    const realHome = home.value
    const alias = join(scratch, 'home-alias')
    linkDirectory(realHome, alias)
    home.value = alias
    const managed = join(alias, 'worktrees/hash/project')
    mkdirSync(managed, { recursive: true })
    writeFileSync(join(managed, 'remove.txt'), 'orphan worktree')
    binding.worktreePath = pathKind === 'configured' ? managed : pathKind === 'canonical' ? realpathSync(managed) : join(realHome, 'worktrees/hash/project')
    saveBinding()
    const result = await worktree.remove('session')
    expect(result.ok).toBe(true)
    expect(existsSync(managed)).toBe(false)
    expectProtectedData()
  })
})
