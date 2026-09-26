import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { basename, join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTestDshHome, testDshHome } from '../../../../.test/test-utils'

const dshHome = vi.hoisted(() => ({ value: '' }))

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  return { ...actual, DSH_HOME: dshHome.value }
})

dshHome.value = testDshHome

type Cleaner = typeof import('./cleaner')['cleaner']
type Worktree = typeof import('./worktree')['worktree']
type Runtime = typeof import('../config/runtime')

let cleaner: Cleaner
let worktree: Worktree
let runtime: Runtime

const repositories: string[] = []

beforeEach(async () => {
  vi.resetModules()
  resetTestDshHome()
  const [cleanerModule, worktreeModule, runtimeModule] = await Promise.all([
    import('./cleaner'),
    import('./worktree'),
    import('../config/runtime'),
  ])
  cleaner = cleanerModule.cleaner
  worktree = worktreeModule.worktree
  runtime = runtimeModule
  runtime.clearHostRuntime()
})

afterEach(() => {
  runtime?.clearHostRuntime()
  for (const repository of repositories.splice(0))
    rmSync(repository, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function createRepository(commit = true): string {
  const repository = mkdtempSync(join(tmpdir(), 'dsh-worktree-repo-'))
  repositories.push(repository)
  git(repository, 'init', '-b', 'main')
  git(repository, 'config', 'user.email', 'test@example.com')
  git(repository, 'config', 'user.name', 'Test')
  writeFileSync(join(repository, 'README.md'), '# repo\n')
  if (commit) {
    git(repository, 'add', '.')
    git(repository, 'commit', '-m', 'init')
  }
  return repository
}

function expectedHash(repository: string, sessionId: string): string {
  return createHash('sha256').update(`${repository}:${sessionId}`).digest('hex').slice(0, 12)
}

function expectedPath(repository: string, sessionId: string): string {
  return join(testDshHome, 'worktrees', expectedHash(repository, sessionId), basename(repository))
}

function hostWithProcessController(controller: unknown): unknown {
  return new Proxy(
    { get: (name: string) => (name === 'worktreeProcessController' ? controller : undefined) },
    {
      get(target, property, receiver) {
        if (property in target)
          return Reflect.get(target, property, receiver)
        throw new Error(`cannot get property "${String(property)}" without inject`)
      },
    },
  )
}

async function waitForDiscard(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const job = cleaner.lookup('', jobId)
    if (job && job.state !== 'deleting') {
      if (job.state === 'failed')
        throw new Error(job.error ?? 'discard job failed')
      return
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`discard job ${jobId} did not settle`)
}

describe('worktree.create', () => {
  it('默认从 refs/heads/main 创建 detached 工作树并落盘绑定', async () => {
    const repository = createRepository()
    const sessionId = 'detached-session'

    const result = await worktree.create(repository, sessionId)
    expect(result.ok).toBe(true)
    if (!result.ok)
      return

    const path = expectedPath(repository, sessionId)
    expect(result.binding.worktreePath).toBe(path)
    expect(result.binding.projectPath).toBe(repository)
    expect(result.binding.ownsBranch).toBe(false)
    expect(result.binding.branchName).toBe('(detached)')
    expect(result.existed).toBe(false)
    expect(existsSync(path)).toBe(true)
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(repository, 'rev-parse', 'refs/heads/main'))
    expect(git(repository, 'branch', '--list', 'dsh/*')).toBe('')
  })

  it('指定分支时创建 dsh/<branch> 工作树，重名时报错', async () => {
    const repository = createRepository()
    const sessionId = 'branch-session'

    const result = await worktree.create(repository, sessionId, { branchName: 'topic-main-source' })
    expect(result.ok).toBe(true)
    if (!result.ok)
      return

    expect(result.binding.branchName).toBe('dsh/topic-main-source')
    expect(result.binding.ownsBranch).toBe(true)
    expect(git(repository, 'branch', '--list', 'dsh/topic-main-source')).toContain('dsh/topic-main-source')

    const conflict = await worktree.create(repository, 'branch-session-2', { branchName: 'dsh/topic-main-source' })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok)
      expect(conflict.error).toBe('分支已存在：dsh/topic-main-source')
  })

  it('目标路径存在未注册的孤儿目录时先清理再重建', async () => {
    const repository = createRepository()
    const sessionId = 'orphan-session'
    const path = expectedPath(repository, sessionId)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'orphan.txt'), 'stale\n')

    const result = await worktree.create(repository, sessionId)
    expect(result.ok).toBe(true)
    expect(existsSync(join(path, 'orphan.txt'))).toBe(false)
    expect(existsSync(join(path, 'README.md'))).toBe(true)
  })

  it('本地缺少 refs/heads/main 时拒绝创建', async () => {
    const repository = createRepository(false)

    const result = await worktree.create(repository, 'no-main-session')
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error).toContain('本地分支 main 不存在或无法解析（refs/heads/main）')
  })

  it('已绑定且工作树仍注册时幂等返回 existed', async () => {
    const repository = createRepository()
    const sessionId = 'idempotent-session'
    const first = await worktree.create(repository, sessionId)
    expect(first.ok).toBe(true)

    const second = await worktree.create(repository, sessionId)
    expect(second.ok).toBe(true)
    if (!second.ok)
      return
    expect(second.existed).toBe(true)
    expect(second.binding.worktreePath).toBe(expectedPath(repository, sessionId))
  })

  it('重复创建时把旧实现遗留的 .agents 符号链接迁移成真实拷贝', async () => {
    const repository = createRepository()
    mkdirSync(join(repository, '.agents', 'skills', 'handle'), { recursive: true })
    writeFileSync(join(repository, '.agents', 'skills', 'handle', 'SKILL.md'), '# handle\n')
    writeFileSync(join(repository, '.gitignore'), '.agents/skills/\n')
    git(repository, 'add', '.gitignore')
    git(repository, 'commit', '-m', 'ignore skills')
    const sessionId = 'legacy-link-session'

    const first = await worktree.create(repository, sessionId)
    expect(first.ok).toBe(true)
    if (!first.ok)
      return

    // 模拟旧实现留下的符号链接
    const agents = join(first.binding.worktreePath, '.agents')
    rmSync(agents, { recursive: true, force: true })
    symlinkSync(join(repository, '.agents'), agents, process.platform === 'win32' ? 'junction' : 'dir')
    expect(lstatSync(agents).isSymbolicLink()).toBe(true)

    const second = await worktree.create(repository, sessionId)
    expect(second.ok).toBe(true)
    if (!second.ok)
      return
    expect(second.log.join('\n')).toContain('Copied the agent skills directory')
    expect(lstatSync(agents).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(agents, 'skills', 'handle', 'SKILL.md'), 'utf8')).toBe('# handle\n')
    expect(git(first.binding.worktreePath, 'status', '--porcelain=v1')).toBe('')
  })
})

describe('worktree.checkout', () => {
  async function createDetached(sessionId: string): Promise<{ repository: string, created: Extract<Awaited<ReturnType<typeof worktree.create>>, { ok: true }> }> {
    const repository = createRepository()
    const created = await worktree.create(repository, sessionId)
    expect(created.ok).toBe(true)
    if (!created.ok)
      throw new Error('worktree.create failed')
    return { repository, created }
  }

  function checkoutKey(created: { binding: { hash: string, dirname: string } }): string {
    return `${created.binding.hash}/${created.binding.dirname}`
  }

  it('复用已存在且指向同一提交的本地分支，不再拒绝检出', async () => {
    const { repository, created } = await createDetached('reuse-session')
    git(repository, 'branch', 'dsh/reused', git(created.binding.worktreePath, 'rev-parse', 'HEAD'))

    const result = await worktree.checkout({
      sessionId: 'reuse-session',
      worktree_hash_dirname: checkoutKey(created),
      branch_name: 'dsh/reused',
    })

    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    expect(git(repository, 'symbolic-ref', '--short', 'HEAD')).toBe('dsh/reused')
    expect(existsSync(created.binding.worktreePath)).toBe(false)
  })

  it('把已存在且落后于工作树 HEAD 的本地分支快进到工作树 HEAD', async () => {
    const { repository, created } = await createDetached('advance-session')
    const path = created.binding.worktreePath
    git(repository, 'branch', 'dsh/behind', 'HEAD')
    writeFileSync(join(path, 'work.txt'), 'work\n')
    git(path, 'add', '.')
    git(path, 'commit', '-m', 'work inside the worktree')
    const worktreeHead = git(path, 'rev-parse', 'HEAD')
    expect(git(repository, 'rev-parse', 'dsh/behind')).not.toBe(worktreeHead)

    const result = await worktree.checkout({
      sessionId: 'advance-session',
      worktree_hash_dirname: checkoutKey(created),
      branch_name: 'dsh/behind',
    })

    expect(result.ok).toBe(true)
    expect(git(repository, 'rev-parse', 'dsh/behind')).toBe(worktreeHead)
    expect(git(repository, 'symbolic-ref', '--short', 'HEAD')).toBe('dsh/behind')
  })

  it('本地主工作区已停在该分支上时直接快进并完成检出', async () => {
    const { repository, created } = await createDetached('recovery-session')
    const path = created.binding.worktreePath
    git(repository, 'checkout', '-b', 'dsh/recovery')
    writeFileSync(join(path, 'work.txt'), 'work\n')
    git(path, 'add', '.')
    git(path, 'commit', '-m', 'work inside the worktree')
    const worktreeHead = git(path, 'rev-parse', 'HEAD')

    const result = await worktree.checkout({
      sessionId: 'recovery-session',
      worktree_hash_dirname: checkoutKey(created),
      branch_name: 'dsh/recovery',
    })

    expect(result.ok).toBe(true)
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(worktreeHead)
    expect(git(repository, 'symbolic-ref', '--short', 'HEAD')).toBe('dsh/recovery')
    expect(existsSync(path)).toBe(false)
  })

  it('已存在的本地分支与工作树 HEAD 分叉时给出明确拒绝', async () => {
    const { repository, created } = await createDetached('diverged-session')
    writeFileSync(join(repository, 'main.txt'), 'main\n')
    git(repository, 'add', '.')
    git(repository, 'commit', '-m', 'main moves on')
    git(repository, 'branch', 'dsh/diverged')

    const result = await worktree.checkout({
      sessionId: 'diverged-session',
      worktree_hash_dirname: checkoutKey(created),
      branch_name: 'dsh/diverged',
    })

    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error).toContain('已分叉')
    expect(existsSync(created.binding.worktreePath)).toBe(true)
  })
})

describe('worktree.remove', () => {
  it('删除前停止该会话的工作树进程', async () => {
    const repository = createRepository()
    const sessionId = 'controller-session'
    const created = await worktree.create(repository, sessionId)
    expect(created.ok).toBe(true)
    if (!created.ok)
      return

    const stopSessionProcesses = vi.fn(async () => {})
    runtime.setCurrentHostInstance(hostWithProcessController({ stopSessionProcesses }) as never)

    const removed = await worktree.remove(sessionId)
    expect(removed.ok).toBe(true)
    expect(stopSessionProcesses).toHaveBeenCalledWith(sessionId, created.binding.worktreePath)
    expect(existsSync(created.binding.worktreePath)).toBe(false)
  })

  it('无宿主实例或控制器缺失时删除依然安全', async () => {
    const repository = createRepository()
    const sessionId = 'no-controller-session'
    const created = await worktree.create(repository, sessionId)
    expect(created.ok).toBe(true)
    if (!created.ok)
      return

    const removed = await worktree.remove(sessionId)
    expect(removed.ok).toBe(true)
    expect(existsSync(created.binding.worktreePath)).toBe(false)
  })

  it('detach 在无宿主实例时不抛出', async () => {
    const repository = createRepository()
    await worktree.create(repository, 'detach-session')

    await expect(worktree.detach({})).resolves.toEqual([])
  })
})

describe('worktree.discard', () => {
  it('异步删除完成后清空空的 hash 容器', async () => {
    const repository = createRepository()
    const sessionId = 'discard-session'
    const created = await worktree.create(repository, sessionId)
    expect(created.ok).toBe(true)
    if (!created.ok)
      return

    const discarded = await worktree.discard(sessionId, `${created.binding.hash}/${created.binding.dirname}`)
    expect(discarded.ok).toBe(true)
    if (!discarded.ok || !discarded.jobId)
      throw new Error('discard did not start a job')

    await waitForDiscard(discarded.jobId)

    expect(existsSync(created.binding.worktreePath)).toBe(false)
    expect(existsSync(join(testDshHome, 'worktrees', created.binding.hash))).toBe(false)
    expect(existsSync(join(testDshHome, '.trash', created.binding.hash))).toBe(false)
  })

  it('未绑定的越界 key 被拒绝，不会删到工作树根之外', async () => {
    const victim = join(testDshHome, 'victim-dir')
    mkdirSync(victim, { recursive: true })
    writeFileSync(join(victim, 'keep.txt'), 'keep\n')

    const discarded = await worktree.discard('escape-session', '../victim-dir')

    expect(discarded.ok).toBe(false)
    expect(existsSync(join(victim, 'keep.txt'))).toBe(true)
  })

  it('未绑定的 key 段数不合法（多余段 / 结尾斜杠）时被拒绝', async () => {
    const hash = 'ffffffffffff'
    const path = join(testDshHome, 'worktrees', hash, 'repo')
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'keep.txt'), 'keep\n')

    const surplus = await worktree.discard('surplus-session', `${hash}/repo/extra`)
    const trailing = await worktree.discard('trailing-session', `${hash}/repo/`)

    expect(surplus.ok).toBe(false)
    expect(trailing.ok).toBe(false)
    expect(existsSync(join(path, 'keep.txt'))).toBe(true)
  })

  it('无绑定且路径已消失时幂等成功且不产生任务', async () => {
    const repository = createRepository()
    const sessionId = 'no-binding-session'
    const key = `${expectedHash(repository, sessionId)}/${basename(repository)}`

    const discarded = await worktree.discard(sessionId, key)
    expect(discarded).toEqual({ ok: true })
  })
})

describe('依赖链接', () => {
  it('默认链接 node_modules，并在删除前解链', async () => {
    const repository = createRepository()
    mkdirSync(join(repository, 'node_modules'), { recursive: true })
    writeFileSync(join(repository, 'node_modules', 'index.js'), 'module.exports = 1\n')
    const sessionId = 'linked-session'

    const created = await worktree.create(repository, sessionId)
    expect(created.ok).toBe(true)
    if (!created.ok)
      return

    const link = join(created.binding.worktreePath, 'node_modules')
    expect(existsSync(link)).toBe(true)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(created.binding.linkedDependencies).toEqual(['node_modules'])

    const removed = await worktree.remove(sessionId)
    expect(removed.ok).toBe(true)
    expect(existsSync(link)).toBe(false)
    expect(existsSync(join(repository, 'node_modules', 'index.js'))).toBe(true)
  })

  it('linkDependencies 为 false 时跳过链接', async () => {
    const repository = createRepository()
    mkdirSync(join(repository, 'node_modules'), { recursive: true })
    const sessionId = 'unlinked-session'

    const created = await worktree.create(repository, sessionId, { linkDependencies: false })
    expect(created.ok).toBe(true)
    if (!created.ok)
      return

    expect(existsSync(join(created.binding.worktreePath, 'node_modules'))).toBe(false)
    expect(created.binding.linkedDependencies).toBeUndefined()
  })

  it('不把 src-tauri/target 构建缓存复制进工作树', async () => {
    const repository = createRepository()
    mkdirSync(join(repository, 'src-tauri', 'src'), { recursive: true })
    writeFileSync(join(repository, 'src-tauri', 'src', 'main.rs'), 'fn main() {}\n')
    writeFileSync(join(repository, '.gitignore'), 'src-tauri/target\n')
    mkdirSync(join(repository, 'src-tauri', 'target', 'debug', 'deps'), { recursive: true })
    writeFileSync(join(repository, 'src-tauri', 'target', 'debug', 'deps', 'libdemo.rlib'), 'artifact\n')
    git(repository, 'add', '.')
    git(repository, 'commit', '-m', 'rust sources')
    const sessionId = 'unseeded-session'

    const created = await worktree.create(repository, sessionId)
    expect(created.ok).toBe(true)
    if (!created.ok)
      return

    expect(existsSync(join(created.binding.worktreePath, 'src-tauri', 'target'))).toBe(false)
    expect(created.log.some(line => line.includes('build cache'))).toBe(false)

    const removed = await worktree.remove(sessionId)
    expect(removed.ok).toBe(true)
    expect(existsSync(join(repository, 'src-tauri', 'target', 'debug', 'deps', 'libdemo.rlib'))).toBe(true)
  })

  it('无条件继承 .agents（复制而非链接），即使关闭依赖链接', async () => {
    const repository = createRepository()
    mkdirSync(join(repository, '.agents', 'skills', 'handle'), { recursive: true })
    writeFileSync(join(repository, '.agents', 'skills', 'handle', 'SKILL.md'), '# handle\n')
    const sessionId = 'skills-session'

    const created = await worktree.create(repository, sessionId, { linkDependencies: false })
    expect(created.ok).toBe(true)
    if (!created.ok)
      return

    const agents = join(created.binding.worktreePath, '.agents')
    expect(lstatSync(agents).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(agents, 'skills', 'handle', 'SKILL.md'), 'utf8')).toBe('# handle\n')
    expect(existsSync(join(created.binding.worktreePath, 'node_modules'))).toBe(false)

    const removed = await worktree.remove(sessionId)
    expect(removed.ok).toBe(true)
    expect(existsSync(agents)).toBe(false)
    expect(readFileSync(join(repository, '.agents', 'skills', 'handle', 'SKILL.md'), 'utf8')).toBe('# handle\n')
  })

  it('源仓库没有 .agents 时创建工作树照常成功', async () => {
    const repository = createRepository()
    const sessionId = 'no-skills-session'

    const created = await worktree.create(repository, sessionId)
    expect(created.ok).toBe(true)
    if (!created.ok)
      return

    expect(existsSync(join(created.binding.worktreePath, '.agents'))).toBe(false)
  })

  it('源仓库忽略 .agents 时，继承不弄脏工作树状态（POSIX 不可用符号链接）', async () => {
    const repository = createRepository()
    mkdirSync(join(repository, '.agents', 'skills', 'handle'), { recursive: true })
    writeFileSync(join(repository, '.agents', 'skills', 'handle', 'SKILL.md'), '# handle\n')
    writeFileSync(join(repository, '.gitignore'), '.agents/skills/\n')
    git(repository, 'add', '.gitignore')
    git(repository, 'commit', '-m', 'ignore skills')
    const sessionId = 'ignored-skills-session'

    const created = await worktree.create(repository, sessionId)
    expect(created.ok).toBe(true)
    if (!created.ok)
      return

    // POSIX 上符号链接对 git 是「文件」，`.agents/skills/` 忽略规则匹配不到它，
    // 会留下 `?? .agents`；复制成真实目录后状态干净。
    expect(git(created.binding.worktreePath, 'status', '--porcelain=v1')).toBe('')
    expect(lstatSync(join(created.binding.worktreePath, '.agents')).isSymbolicLink()).toBe(false)
  })

  it('部分内容已跟踪时，补齐被忽略的 .agents/skills 子目录', async () => {
    const repository = createRepository()
    mkdirSync(join(repository, '.agents', 'skills', 'handle'), { recursive: true })
    writeFileSync(join(repository, '.agents', 'config.json'), '{}\n')
    writeFileSync(join(repository, '.agents', 'skills', 'handle', 'SKILL.md'), '# handle\n')
    writeFileSync(join(repository, '.gitignore'), '.agents/skills/\n')
    git(repository, 'add', '.gitignore', '.agents/config.json')
    git(repository, 'commit', '-m', 'track agents config')
    const sessionId = 'partial-skills-session'

    const created = await worktree.create(repository, sessionId)
    expect(created.ok).toBe(true)
    if (!created.ok)
      return

    const skills = join(created.binding.worktreePath, '.agents', 'skills')
    expect(readFileSync(join(skills, 'handle', 'SKILL.md'), 'utf8')).toBe('# handle\n')
    expect(lstatSync(join(created.binding.worktreePath, '.agents')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(created.binding.worktreePath, '.agents', 'config.json'), 'utf8').trim()).toBe('{}')
    expect(git(created.binding.worktreePath, 'status', '--porcelain=v1')).toBe('')

    const removed = await worktree.remove(sessionId)
    expect(removed.ok).toBe(true)
    expect(readFileSync(join(repository, '.agents', 'skills', 'handle', 'SKILL.md'), 'utf8')).toBe('# handle\n')
  })
})
