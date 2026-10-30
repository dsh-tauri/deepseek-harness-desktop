import type { Binding } from '../types'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTestDshHome, testDshHome } from '../../../../.test/test-utils'
import { TRASH_DIR, WORKTREES_DIR } from '../config/constants'

const dshHome = vi.hoisted(() => ({ value: '' }))

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  return { ...actual, DSH_HOME: dshHome.value }
})

dshHome.value = testDshHome

const HASH = 'a1b2c3d4e5f6'
const DIRNAME = 'repo'

type Jobs = typeof import('./jobs')['jobs']
type Ledger = typeof import('./ledger')['ledger']
type Worktree = typeof import('./worktree')['worktree']
type Paths = typeof import('../utils/paths')

let jobs: Jobs
let ledger: Ledger
let worktree: Worktree
let paths: Paths

beforeEach(async () => {
  vi.resetModules()
  resetTestDshHome()
  const [jobsModule, ledgerModule, worktreeModule, pathsModule] = await Promise.all([
    import('./jobs'),
    import('./ledger'),
    import('./worktree'),
    import('../utils/paths'),
  ])
  jobs = jobsModule.jobs
  ledger = ledgerModule.ledger
  worktree = worktreeModule.worktree
  paths = pathsModule
})

function age(path: string): void {
  const past = new Date(Date.now() - 10 * 60_000)
  utimesSync(path, past, past)
}

function writeQueue(records: unknown[]): void {
  mkdirSync(join(testDshHome, WORKTREES_DIR), { recursive: true })
  writeFileSync(join(testDshHome, WORKTREES_DIR, 'jobs.json'), `${JSON.stringify({ version: 1, jobs: records })}\n`)
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate())
      return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('condition was not met in time')
}

function makeBinding(overrides: Partial<Binding>): Binding {
  return {
    sessionId: 'session-stale',
    sourceSessionId: 'session-source',
    hash: 'deadbeefcafe',
    dirname: DIRNAME,
    worktreePath: paths.worktreePath('deadbeefcafe', DIRNAME),
    projectPath: '/tmp/repo',
    branchName: '(detached)',
    ownsBranch: false,
    createdAt: new Date().toISOString(),
    log: [],
    ...overrides,
  }
}

describe('worktree.recover', () => {
  it('把上次未完成的删除任务落回队列并重跑，随后清空 jobs.json', async () => {
    const path = paths.worktreePath(HASH, DIRNAME)
    mkdirSync(path, { recursive: true })
    writeQueue([{
      jobId: 'job-restored',
      sessionId: 'session-restored',
      worktreeKey: `${HASH}/${DIRNAME}`,
      worktreePath: path,
      state: 'deleting',
    }])

    const result = await worktree.recover()
    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    expect(result.resumed).toBe(1)

    await waitFor(() => jobs.load().length === 0)

    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(testDshHome, WORKTREES_DIR, HASH))).toBe(false)
    expect(existsSync(join(testDshHome, TRASH_DIR, HASH))).toBe(false)
    expect(jobs.load()).toEqual([])
  })

  it('清扫回收站残留与空壳目录，但保留仍有内容的工作树', async () => {
    const shell = paths.worktreePath(HASH, DIRNAME)
    const occupied = paths.worktreePath('bbbcccdddeee', 'keeper')
    const trash = join(testDshHome, TRASH_DIR, 'ffffffaaaaaa', DIRNAME)
    mkdirSync(shell, { recursive: true })
    mkdirSync(occupied, { recursive: true })
    writeFileSync(join(occupied, 'keep.txt'), 'keep\n')
    mkdirSync(trash, { recursive: true })
    writeFileSync(join(trash, 'stale.txt'), 'stale\n')
    for (const path of [shell, join(testDshHome, WORKTREES_DIR, HASH), occupied, join(testDshHome, WORKTREES_DIR, 'bbbcccdddeee')])
      age(path)

    const result = await worktree.recover()
    expect(result.ok).toBe(true)

    expect(existsSync(shell)).toBe(false)
    expect(existsSync(join(testDshHome, WORKTREES_DIR, HASH))).toBe(false)
    expect(existsSync(join(testDshHome, TRASH_DIR, 'ffffffaaaaaa'))).toBe(false)
    expect(existsSync(join(occupied, 'keep.txt'))).toBe(true)
  })

  it('回收目录已消失的绑定记录', async () => {
    await ledger.save('session-stale', makeBinding({}))

    const result = await worktree.recover()
    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    expect(result.pruned).toBe(1)
    expect(ledger.load('session-stale')).toBeNull()
  })

  it('jobs.json 损坏时按空队列处理', () => {
    mkdirSync(join(testDshHome, WORKTREES_DIR), { recursive: true })
    writeFileSync(join(testDshHome, WORKTREES_DIR, 'jobs.json'), '{ not json')

    expect(jobs.load()).toEqual([])
  })

  it('jobs.json 读取失败但并非文件缺失时如实抛错', () => {
    mkdirSync(join(testDshHome, WORKTREES_DIR, 'jobs.json'), { recursive: true })

    expect(() => jobs.load()).toThrow()
  })

  it('落盘的 attempts 只接受非负安全整数', () => {
    writeQueue([
      { jobId: 'job-negative', sessionId: 'session-negative', worktreeKey: `${HASH}/${DIRNAME}`, state: 'failed', attempts: -3 },
      { jobId: 'job-fraction', sessionId: 'session-fraction', worktreeKey: `${HASH}/${DIRNAME}`, state: 'failed', attempts: 1.5 },
    ])

    expect(jobs.load().map(record => record.attempts)).toEqual([0, 0])
  })
})
