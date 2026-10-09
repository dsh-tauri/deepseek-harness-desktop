import type { Binding } from '../types'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTestDshHome, testDshHome } from '../../../../.test/test-utils'
import { resetRuntime } from '../config/runtime'
import { server } from '../server'
import { linkWorktreeDependencies, shellCommandFrom } from '../utils/dependencies'
import { worktree } from './worktree'

const disposers: Array<() => void> = []

function disposeServers(): void {
  for (const dispose of disposers.splice(0))
    dispose()
}

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  const { testDshHome: home } = await import('../../../../.test/test-utils')
  return { ...actual, DSH_HOME: home }
})

const temporaryDirectories: string[] = []

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(root)
  return root
}

beforeEach(() => {
  resetTestDshHome()
  resetRuntime()
})

afterEach(async () => {
  disposeServers()
  resetRuntime()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function createLinkedWorktreeFixture(
  sessionId: string,
  linkedDependencies: string[] = ['node_modules'],
): Promise<{ project: string, worktree: string, marker: string }> {
  const project = await temporaryRoot('dsh-detach-project-')
  const worktreePath = await temporaryRoot('dsh-detach-worktree-')
  const marker = join(project, 'node_modules', 'pkg', 'index.js')
  await mkdir(join(project, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(marker, 'shared-dependency\n')
  for (const name of linkedDependencies) {
    if (name === 'node_modules')
      continue
    await mkdir(join(project, name, 'lib'), { recursive: true })
  }
  await linkWorktreeDependencies(project, worktreePath, linkedDependencies)

  await mkdir(join(testDshHome, 'ledger'), { recursive: true })
  const binding: Binding = {
    sessionId,
    sourceSessionId: sessionId,
    hash: 'hash',
    dirname: 'project',
    worktreePath,
    projectPath: project,
    branchName: '(detached)',
    ownsBranch: false,
    createdAt: new Date().toISOString(),
    log: [],
    linkedDependencies,
  }
  await writeFile(join(testDshHome, 'ledger', `${sessionId}.json`), `${JSON.stringify(binding, null, 2)}\n`)

  return { project, worktree: worktreePath, marker }
}

describe('shellCommandFrom', () => {
  it('reads the command from known shell tools', () => {
    expect(shellCommandFrom({ name: 'pwsh', arguments: { command: 'pnpm install' } })).toBe('pnpm install')
    expect(shellCommandFrom({ name: 'bash', arguments: { cmd: 'npm ci' } })).toBe('npm ci')
    expect(shellCommandFrom({ name: 'shell', arguments: { script: 'yarn' } })).toBe('yarn')
  })

  it('ignores non-shell tools and malformed executions', () => {
    expect(shellCommandFrom({ name: 'read', arguments: { command: 'pnpm install' } })).toBe('')
    expect(shellCommandFrom({ name: 'pwsh', arguments: {} })).toBe('')
    expect(shellCommandFrom({ name: 'pwsh' })).toBe('')
    expect(shellCommandFrom(undefined)).toBe('')
  })
})

describe('worktree.detach', () => {
  it('unlinks the shared dependency directory before an install command runs', async () => {
    const sessionId = 'session-install'
    const { project, worktree: worktreePath, marker } = await createLinkedWorktreeFixture(sessionId)
    const info = vi.fn()
    disposers.push(server({ logger: { info }, webServer: { register: () => () => {} } } as never))

    const unlinked = await worktree.detach({
      name: 'pwsh',
      arguments: { command: 'pnpm install' },
      agent: { session: { id: sessionId } },
    })

    expect(unlinked).toEqual(['node_modules'])
    await expect(lstat(join(worktreePath, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(marker, 'utf8')).toBe('shared-dependency\n')
    expect(await readFile(join(project, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('shared-dependency\n')
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('leaves the link in place for non-install commands and unknown sessions', async () => {
    const sessionId = 'session-other'
    const { worktree: worktreePath } = await createLinkedWorktreeFixture(sessionId)
    const info = vi.fn()
    disposers.push(server({ logger: { info }, webServer: { register: () => () => {} } } as never))

    const nonInstall = await worktree.detach({
      name: 'pwsh',
      arguments: { command: 'pnpm run build' },
      agent: { session: { id: sessionId } },
    })
    expect(nonInstall).toEqual([])

    const unknownSession = await worktree.detach({
      name: 'pwsh',
      arguments: { command: 'pnpm install' },
      agent: { session: { id: 'session-missing' } },
    })
    expect(unknownSession).toEqual([])
    expect((await lstat(join(worktreePath, 'node_modules'))).isSymbolicLink()).toBe(true)
    expect(info).not.toHaveBeenCalled()
  })

  it('unlinks extra dependency directories recorded in the binding', async () => {
    const sessionId = 'session-venv'
    const { worktree: worktreePath } = await createLinkedWorktreeFixture(sessionId, ['node_modules', '.venv'])
    disposers.push(server({ logger: { info: vi.fn() }, webServer: { register: () => () => {} } } as never))

    const unlinked = await worktree.detach({
      name: 'pwsh',
      arguments: { command: 'uv sync' },
      agent: { session: { id: sessionId } },
    })

    expect(unlinked).toEqual(['node_modules', '.venv'])
    await expect(lstat(join(worktreePath, '.venv'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(worktreePath, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns no unlinks for tools that are not shell tools', async () => {
    const sessionId = 'session-non-shell'
    const { worktree: worktreePath } = await createLinkedWorktreeFixture(sessionId)
    disposers.push(server({ logger: { info: vi.fn() }, webServer: { register: () => () => {} } } as never))

    await expect(worktree.detach({ name: 'read', arguments: { command: 'pnpm install' } })).resolves.toEqual([])
    expect((await lstat(join(worktreePath, 'node_modules'))).isSymbolicLink()).toBe(true)
  })
})
