import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { REASON_GIT_REQUIRED, REASON_UNSAFE_WORKSPACE } from '../config/constants'
import { disposeRuntime } from '../config/runtime'
import { server } from '../server'
import { workspaceKey } from '../utils/workspace'
import { workspace } from './workspace'

const run = promisify(execFile)

const temporaryDirectories: string[] = []
const disposers: Array<() => void> = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-running-changes-workspace-'))
  temporaryDirectories.push(root)
  return root
}

async function initRepo(path: string): Promise<void> {
  await run('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', path], { windowsHide: true })
}

/** 绑一个假宿主：`workspace.resolve` 的 cwd 只能来自宿主 SessionStore（get 优先，list 兜底）。 */
function bindSessions(cwds: Record<string, string | undefined>): void {
  const rows = Object.entries(cwds).map(([id, cwd]) => ({ id, header: cwd === undefined ? {} : { cwd } }))
  disposers.push(server({
    webServer: { register: () => () => {} },
    sessions: {
      get: (id: string) => rows.find(row => row.id === id),
      list: () => rows,
    },
  } as never))
}

afterEach(async () => {
  disposeRuntime()
  disposers.splice(0).forEach(dispose => dispose())
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('workspace.resolve', () => {
  it('reports RUNNING_CHANGES_GIT_REQUIRED outside a Git worktree', async () => {
    const root = await tempRoot()
    bindSessions({ session: root })
    const probe = await workspace.resolve('session')
    expect(probe).toEqual({ ok: false, reason: REASON_GIT_REQUIRED })
  })

  it('refuses a system-sensitive cwd before consulting git', async () => {
    const home = homedir()
    expect(home.length).toBeGreaterThan(0)
    bindSessions({ session: home })
    const probe = await workspace.resolve('session')
    expect(probe).toEqual({ ok: false, reason: REASON_UNSAFE_WORKSPACE })
  })

  it('resolves a subdirectory session to the worktree root', async () => {
    const root = await tempRoot()
    await initRepo(root)
    await mkdir(join(root, 'packages', 'app'), { recursive: true })
    await writeFile(join(root, 'packages', 'app', 'index.ts'), 'export {}\n', 'utf8')

    bindSessions({ 'session-root': root, 'session-subdir': join(root, 'packages', 'app') })
    const fromRoot = await workspace.resolve('session-root')
    const fromSubdir = await workspace.resolve('session-subdir')
    expect(fromRoot.ok).toBe(true)
    expect(fromSubdir.ok).toBe(true)
    if (fromRoot.ok && fromSubdir.ok)
      expect(workspaceKey(fromSubdir.root)).toBe(workspaceKey(fromRoot.root))
  })

  it('treats a missing cwd as not-a-Git-workspace instead of guessing process.cwd()', async () => {
    bindSessions({ 'session-missing': undefined, 'session-empty': '' })
    expect(await workspace.resolve('session-missing')).toEqual({ ok: false, reason: REASON_GIT_REQUIRED })
    expect(await workspace.resolve('session-empty')).toEqual({ ok: false, reason: REASON_GIT_REQUIRED })
  })
})
