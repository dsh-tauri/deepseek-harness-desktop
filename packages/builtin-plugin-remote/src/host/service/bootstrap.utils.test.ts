import type { DshZipPlan, RemoteInstallPlan } from './bootstrap.types'
import { describe, expect, it } from 'vitest'
import { GithubHttpError } from '../utils/version'
import { planRemoteInstall } from './bootstrap.utils'

async function failing(): Promise<never> {
  throw new Error('network unreachable')
}

function zipPlanOf(plan: RemoteInstallPlan): DshZipPlan {
  if (plan.dsh.kind !== 'pkg-zip')
    throw new Error('expected a pkg-zip install plan')
  return plan.dsh
}

describe('planRemoteInstall 的 release 候选选择', () => {
  it('资产元数据缺失时按候选顺序取第一个存在的发行包', async () => {
    const plan = await planRemoteInstall('Linux x86_64', {}, {
      listReleases: failing,
      listAssets: async (_repo, tag) => {
        if (tag !== 'dsh-0.2.2-rc.1-43048423223')
          return []
        return [{ name: 'deepseek-harness-pkg-linux.zip', url: 'https://example.invalid/linux.zip', digest: 'sha256:aa' }]
      },
    })
    expect(zipPlanOf(plan).tag).toBe('dsh-0.2.2-rc.1-43048423223')
    expect(plan.dsh.urls).toContain('https://example.invalid/linux.zip')
  })

  it('首个候选 404 时改用第二个候选的资产', async () => {
    const plan = await planRemoteInstall('Linux x86_64', {}, {
      listReleases: failing,
      listAssets: async (_repo, tag) => {
        if (tag === 'dsh-0.2.2-rc.1-43078653398')
          throw new GithubHttpError('https://api.github.com/repos/x/y/releases/tags/t', 404)
        return [{ name: 'deepseek-harness-pkg-linux.zip', url: 'https://example.invalid/linux.zip', digest: 'sha256:aa' }]
      },
    })
    expect(zipPlanOf(plan).tag).toBe('dsh-0.2.2-rc.1-43048423223')
  })

  it('元数据不可达时不再逐个查询其余候选', async () => {
    const queried: string[] = []
    await planRemoteInstall('Linux x86_64', {}, {
      listReleases: failing,
      listAssets: async (_repo, tag) => {
        queried.push(tag)
        throw new Error('network unreachable')
      },
      probe: async () => 'unknown',
    })
    expect(queried).toEqual(['dsh-0.2.2-rc.1-43078653398'])
  })

  it('全部候选确认不存在时终止规划并报告版本不可用', async () => {
    await expect(planRemoteInstall('Linux x86_64', {}, {
      listReleases: failing,
      listAssets: async () => { throw new GithubHttpError('https://api.github.com/repos/x/y/releases/tags/t', 404) },
      probe: async () => 'missing',
    })).rejects.toThrow(/REMOTE_DSH_RELEASE_UNAVAILABLE/)
  })

  it('元数据缺失且探测确认不存在时同样终止规划', async () => {
    await expect(planRemoteInstall('Linux x86_64', {}, {
      listReleases: failing,
      listAssets: async () => [],
      probe: async () => 'missing',
    })).rejects.toThrow(/REMOTE_DSH_RELEASE_UNAVAILABLE/)
  })

  it('可用性未知时保留候选，不误报为版本不可用', async () => {
    const plan = await planRemoteInstall('Linux x86_64', {}, {
      listReleases: failing,
      listAssets: failing,
      probe: async () => 'unknown',
    })
    expect(zipPlanOf(plan).tag).toBe('dsh-0.2.2-rc.1-43078653398')
    expect(plan.dsh.urls.length).toBeGreaterThan(0)
  })

  it('探测到可下载的候选时直接采用该候选', async () => {
    const plan = await planRemoteInstall('Linux x86_64', {}, {
      listReleases: failing,
      listAssets: failing,
      probe: async url => (url.includes('43078653398') ? 'available' : 'missing'),
    })
    expect(zipPlanOf(plan).tag).toBe('dsh-0.2.2-rc.1-43078653398')
  })
})
