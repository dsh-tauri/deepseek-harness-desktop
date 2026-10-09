import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTestDshHome, testDshHome } from '../../../../.test/test-utils'
import { MAX_FILE_BYTES } from '../config/constants'
import { disposeRuntime } from '../config/runtime'
import { gitInRepo, gitInSnapshot } from '../utils/git'
import { retention } from './retention'
import { snapshot } from './snapshot'

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  const { testDshHome: home } = await import('../../../../.test/test-utils')
  return { ...actual, DSH_HOME: home }
})

const run = promisify(execFile)

const temporaryDirectories: string[] = []

type Store = ReturnType<typeof snapshot.resolve>

const GIT_IDENTITY = ['-c', 'user.email=test@example.com', '-c', 'user.name=test']

async function fixture(): Promise<{ worktree: string, store: Store }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-running-changes-retention-'))
  temporaryDirectories.push(root)
  const worktree = join(root, 'project')
  await mkdir(worktree, { recursive: true })
  await run('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', worktree], { windowsHide: true })
  await writeFile(join(worktree, 'a.txt'), 'tracked\n', 'utf8')
  await run('git', ['-C', worktree, ...GIT_IDENTITY, 'add', '--all'], { windowsHide: true })
  await run('git', ['-C', worktree, ...GIT_IDENTITY, 'commit', '--quiet', '-m', 'init'], { windowsHide: true })
  const store = snapshot.resolve(worktree)
  const ensured = await snapshot.capture(store, snapshot.ref('retention-fixture', 1, 'before'), 'retention fixture')
  expect(ensured.ok).toBe(true)
  return { worktree, store }
}

/** `resetTestDshHome` 不覆盖插件数据目录（快照私有仓），用例间必须自行清理。 */
function cleanPluginData(): void {
  rmSync(join(testDshHome, 'dsh-tauri-experimental'), { recursive: true, force: true })
}

beforeEach(() => {
  resetTestDshHome()
  cleanPluginData()
})

afterEach(async () => {
  disposeRuntime()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  cleanPluginData()
})

/** 造出两个「值得排除」的对象：超限文件 + 嵌套仓库。 */
async function makeExcludable(worktree: string): Promise<{ bigPath: string, nested: string }> {
  const bigPath = join(worktree, 'big.bin')
  await writeFile(bigPath, Buffer.alloc(MAX_FILE_BYTES + 1024))
  const nested = join(worktree, 'nested')
  await mkdir(join(nested, '.git'), { recursive: true })
  return { bigPath, nested }
}

describe('排除清单', () => {
  it('写读往返：丢弃越界路径并去重', async () => {
    const { worktree, store } = await fixture()
    await makeExcludable(worktree)
    await retention.write(store, ['big.bin', 'nested', '../escape.txt', '/abs/outside.txt', 'big.bin'])
    // 越界路径读回时必须被丢掉：绝不接受账本/清单里的逃逸路径。
    expect((await retention.read(store)).sort()).toEqual(['big.bin', 'nested'])
  })

  it('文件缩回上限内、嵌套仓库消失后自动移出清单', async () => {
    const { worktree, store } = await fixture()
    const { bigPath, nested } = await makeExcludable(worktree)

    await retention.write(store, ['big.bin', 'nested'])
    expect((await retention.read(store)).sort()).toEqual(['big.bin', 'nested'])

    await writeFile(bigPath, 'small', 'utf8')
    await rm(nested, { recursive: true, force: true })
    expect(await retention.read(store)).toEqual([])
    // 复检结论已回写磁盘：后续读取不再重复判定。
    expect(existsSync(`${store.gitDir}.exclude.json`)).toBe(true)
  })
})

describe('容量治理', () => {
  it('prune 回收不可达对象，但不碰 refs/running-changes/* 链上的对象', async () => {
    const { worktree, store } = await fixture()
    const captured = await snapshot.capture(store, snapshot.ref('s1', 1, 'before'), 'turn 1 before')
    expect(captured.ok).toBe(true)

    // 造一个没有任何 ref 可达的 loose object——正是实时读数每 1.5s 产生的那些东西。
    const orphan = join(worktree, 'orphan.txt')
    await writeFile(orphan, 'unreachable content\n', 'utf8')
    const hashed = await run('git', ['--git-dir', store.gitDir, 'hash-object', '-w', orphan], { windowsHide: true })
    const oid = hashed.stdout.trim()
    expect(oid).toMatch(/^[0-9a-f]{40}$/)
    await rm(orphan, { force: true })

    const outcome = await retention.enforce(store, { maxRepoMb: 1024 })
    expect(outcome.pruned).toBe(true)
    expect(outcome.rebuilt).toBe(false)
    const orphanAlive = await gitInSnapshot(store, ['cat-file', '-e', oid]).then(result => result.ok)
    expect(orphanAlive).toBe(false)
    // 被 ref 引用的快照仍然完好。
    const refAlive = await gitInSnapshot(store, ['rev-parse', '--verify', snapshot.ref('s1', 1, 'before')]).then(result => result.ok)
    expect(refAlive).toBe(true)
  })

  it('超过容量上限：整仓隔离重建 + 代数轮换 + 排除清单清空', async () => {
    const { store } = await fixture()
    await retention.write(store, ['a.txt'])
    const beforeGeneration = store.generation
    const sizeMb = await retention.measure(store.gitDir)
    expect(sizeMb).toBeGreaterThan(0)

    // 用一个极小上限触发重建路径（真实上限 2GB，测试造不出来）。
    const outcome = await retention.enforce(store, { maxRepoMb: sizeMb / 2 })
    expect(outcome.rebuilt).toBe(true)
    expect(outcome.exclusions).toEqual([])
    expect(existsSync(join(store.gitDir, 'HEAD'))).toBe(false)
    // 隔离目录是过渡态，必须被清掉；残留会让下次重建拿到脏数据。
    expect(existsSync(`${store.gitDir}.retention-quarantine`)).toBe(false)
    // 代数轮换 → 账本里的旧记录自然转为「已过期」。
    expect(store.generation).toBeTypeOf('string')
    expect(store.generation).not.toBe(beforeGeneration)
    expect(store.rebuiltReason).toContain('exceeded')
  })

  it('隔离目录残留时重建前先清场', async () => {
    const { store } = await fixture()
    // 模拟上一次重建死在 `rm` 之前：隔离目录里躺着旧仓。
    await rename(store.gitDir, `${store.gitDir}.retention-quarantine`).catch(() => undefined)
    const ensured = await snapshot.capture(store, snapshot.ref('retention-recheck', 1, 'before'), 'recheck')
    expect(ensured.ok).toBe(true)
    const outcome = await retention.enforce(store, { maxRepoMb: 0 })
    expect(outcome.rebuilt).toBe(true)
    expect(existsSync(`${store.gitDir}.retention-quarantine`)).toBe(false)
  })
})

describe('retention.measure', () => {
  it('counts nested file bytes and treats a missing directory as empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-running-changes-measure-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'a.bin'), Buffer.alloc(7))
    await writeFile(join(root, 'nested', 'b.bin'), Buffer.alloc(11))

    expect(await retention.measure(root)).toBe(18 / (1024 * 1024))
    expect(await retention.measure(join(root, 'absent'))).toBe(0)
  })

  it('stats directory links without traversing their target files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-running-changes-measure-link-'))
    temporaryDirectories.push(root)
    const measured = join(root, 'measured')
    const outside = join(root, 'outside')
    const link = join(measured, 'linked')
    await mkdir(measured)
    await mkdir(outside)
    await writeFile(join(outside, 'large.bin'), Buffer.alloc(4096))
    await symlink(outside, link, 'junction')

    const target = await stat(outside)
    expect(await retention.measure(measured)).toBe(target.size / (1024 * 1024))
  })
})

describe('工作区状态', () => {
  it('治理不修改用户仓库（私有仓之外零副作用）', async () => {
    const { worktree, store } = await fixture()
    await writeFile(join(worktree, 'a.txt'), 'dirty\n', 'utf8')

    const head = await gitInRepo(worktree, ['rev-parse', 'HEAD']).then(result => (result.ok ? result.out.trim() : 'no-head'))
    const status = await gitInRepo(worktree, ['status', '--porcelain=v1']).then(result => (result.ok ? result.out.trim() : ''))
    const content = await readFile(join(worktree, 'a.txt'), 'utf8')
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(status).toBe('M a.txt')
    expect(content).toBe('dirty\n')

    await retention.enforce(store, { maxRepoMb: 0 })

    const after = await gitInRepo(worktree, ['rev-parse', 'HEAD']).then(result => (result.ok ? result.out.trim() : 'no-head'))
    const afterStatus = await gitInRepo(worktree, ['status', '--porcelain=v1']).then(result => (result.ok ? result.out.trim() : ''))
    const afterContent = await readFile(join(worktree, 'a.txt'), 'utf8')
    expect(after).toBe(head)
    expect(after).toMatch(/^[0-9a-f]{40}$/)
    expect(afterStatus).toBe('M a.txt')
    expect(afterContent).toBe(content)
  })
})
