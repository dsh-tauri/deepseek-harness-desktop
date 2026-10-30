import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTestDshHome, testDshHome } from '../../../../.test/test-utils'

const dshHome = vi.hoisted(() => ({ value: '' }))

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  return { ...actual, DSH_HOME: dshHome.value }
})

dshHome.value = testDshHome

type Cleaner = typeof import('./cleaner')['cleaner']
type Jobs = typeof import('./jobs')['jobs']

let cleaner: Cleaner
let jobs: Jobs

beforeEach(async () => {
  vi.resetModules()
  resetTestDshHome()
  const [cleanerModule, jobsModule] = await Promise.all([import('./cleaner'), import('./jobs')])
  cleaner = cleanerModule.cleaner
  jobs = jobsModule.jobs
})

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate())
      return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('condition was not met in time')
}

function settleCount(jobId: string): number {
  return jobs.load().find(record => record.jobId === jobId)?.attempts ?? 0
}

describe('cleaner 退避重试', () => {
  it('一轮失败后自己再来一轮，不需要外部巡检', async () => {
    let calls = 0
    const job = cleaner.start('session-backoff', 'backoff/repo', '/tmp/backoff', async () => {
      calls += 1
      return calls <= 3 ? { ok: false, error: 'locked' } : { ok: true }
    })

    await waitFor(() => cleaner.lookup('session-backoff', job.jobId)?.state === 'failed')
    expect(calls).toBe(3)
    await waitFor(() => settleCount(job.jobId) === 3)
    expect(jobs.load()[0]).toMatchObject({ jobId: job.jobId, state: 'failed', error: 'locked', attempts: 3 })

    await waitFor(() => cleaner.lookup('session-backoff', job.jobId)?.state === 'completed')
    expect(calls).toBe(4)
    expect(cleaner.lookup('session-backoff', job.jobId)?.error).toBeUndefined()
    expect(cleaner.unsettled()).toEqual([])
    await waitFor(() => jobs.load().length === 0)
  })

  it('退避等待期间不重复触发，显式丢弃才立刻重来', async () => {
    let calls = 0
    const run = async (): Promise<{ ok: true } | { ok: false, error: string }> => {
      calls += 1
      return calls <= 3 ? { ok: false, error: 'locked' } : { ok: true }
    }
    const first = cleaner.start('session-force', 'force/repo', '/tmp/force', run)
    await waitFor(() => cleaner.lookup('session-force', first.jobId)?.state === 'failed')

    const idle = cleaner.start('session-force', 'force/repo', '/tmp/force', run)
    expect(idle.jobId).toBe(first.jobId)
    expect(idle.state).toBe('failed')
    expect(calls).toBe(3)

    const forced = cleaner.start('session-force', 'force/repo', '/tmp/force', run, true)
    expect(forced.jobId).toBe(first.jobId)
    await waitFor(() => cleaner.lookup('session-force', first.jobId)?.state === 'completed')
    expect(calls).toBe(4)
  })

  it('同键任务完成后再强制丢弃会真的重跑', async () => {
    let calls = 0
    const run = async (): Promise<{ ok: true }> => {
      calls += 1
      return { ok: true }
    }
    const first = cleaner.start('session-recreate', 'recreate/repo', '/tmp/recreate', run, true)
    await waitFor(() => cleaner.lookup('session-recreate', first.jobId)?.state === 'completed')
    expect(calls).toBe(1)

    cleaner.start('session-recreate', 'recreate/repo', '/tmp/recreate', run, true)
    await waitFor(() => calls === 2)
    expect(cleaner.lookup('session-recreate', first.jobId)?.state).toBe('completed')
  })
})
