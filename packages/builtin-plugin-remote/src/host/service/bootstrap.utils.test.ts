import type { DshZipPlan, RemoteInstallPlan } from './bootstrap.types'
import { describe, expect, it } from 'vitest'
import { GithubHttpError } from '../utils/version'
import { buildInstallScript, planRemoteInstall, startCommandFor } from './bootstrap.utils'

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

describe('install 脚本的重新安装短路', () => {
  function zipPlan(): RemoteInstallPlan {
    return {
      os: 'linux',
      arch: 'x64',
      matrix: { os: 'linux', arch: 'x64', dshKind: 'pkg-zip', nodeFilename: 'node-v22.22.0-linux-x64.tar.gz', dshZipName: 'deepseek-harness-pkg-linux.zip' },
      repo: 'dsh-tauri/deepseek-harness-pkg',
      dshEntry: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
      dshVersion: '0.2.2-rc.1',
      node: { urls: ['https://example.invalid/node.tar.gz'], shasumUrls: ['https://example.invalid/SHASUMS256.txt'], shasumSha256: 'a'.repeat(64), filename: 'node-v22.22.0-linux-x64.tar.gz', version: 'v22.22.0' },
      dsh: { kind: 'pkg-zip', urls: ['https://example.invalid/dsh.zip'], digest: 'sha256:bb', zipName: 'deepseek-harness-pkg-linux.zip', tag: 'dsh-0.2.2-rc.1-43078653398' },
      pnpm: { urls: ['https://example.invalid/pnpm.tgz'], sha256: 'c'.repeat(64), version: '11.7.0' },
      notes: [],
    }
  }

  function npmPlan(): RemoteInstallPlan {
    return {
      ...zipPlan(),
      arch: 'arm64',
      matrix: { os: 'linux', arch: 'arm64', dshKind: 'npm-tgz', nodeFilename: 'node-v22.22.0-linux-arm64.tar.gz', dshNpmPackage: '@deepseek-ai/dsh' },
      dshEntry: 'lib/bin.js',
      dsh: { kind: 'npm-tgz', urls: ['https://example.invalid/dsh.tgz'], integrity: 'sha256:dd', packageName: '@deepseek-ai/dsh', version: '0.2.2-rc.1' },
    }
  }

  it('默认脚本保留「已装好就跳过」的短路，且 REINSTALL 留空', () => {
    const script = buildInstallScript(zipPlan())
    expect(script.split('\n').slice(0, 2)).toEqual(['set -eu', 'REINSTALL='])
    expect(script).toContain('[ -z "$REINSTALL" ]')
  })

  it('强制重装时置 REINSTALL=1，让 pkg-zip 的已装短路失效', () => {
    const script = buildInstallScript(zipPlan(), { force: true })
    expect(script.split('\n').slice(0, 2)).toEqual(['set -eu', 'REINSTALL=1'])
    expect(script).toContain('if [ -f "$ROOT/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" ] && [ -z "$REINSTALL" ]; then')
    expect(script).toContain('log download "dsh dsh-0.2.2-rc.1-43078653398"')
  })

  it('强制重装时 npm-tgz 布局同样绕过短路', () => {
    const plain = buildInstallScript(npmPlan())
    const forced = buildInstallScript(npmPlan(), { force: true })
    expect(plain.split('\n')[1]).toBe('REINSTALL=')
    expect(forced.split('\n')[1]).toBe('REINSTALL=1')
    expect(forced).toContain('if [ -f "$ROOT/dependencies/dsh/lib/bin.js" ] && [ -z "$REINSTALL" ]; then')
  })

  it('node 与 pnpm 不受影响，强制重装仍保留它们自己的就绪判断', () => {
    const script = buildInstallScript(zipPlan(), { force: true })
    expect(script).toContain('if [ -x "$ROOT/runtime/bin/node" ]; then')
    expect(script).toContain('if [ -f "$ROOT/dependencies/pnpm/bin/pnpm.cjs" ]; then')
  })
})

describe('远端实例的启动命令', () => {
  it('远端核心也要信任远端自己的系统 CA store', () => {
    const command = startCommandFor({ id: 'm1' as never, name: 'm1', host: 'h', user: 'u', port: 22, remotePort: 3089 })
    expect(command).toContain('--use-system-ca')
    // 追加在远端已有的 NODE_OPTIONS 之后，而不是覆盖它。
    expect(command).toMatch(/export NODE_OPTIONS="\$\{NODE_OPTIONS:-\} --use-system-ca"/)
    // 开关不被远端 node 认识时必须跳过，不能把远端核心带崩。
    expect(command).toContain('"$NODE" --use-system-ca -e')
  })

  it('用户自定义的启动命令原样保留', () => {
    const command = startCommandFor({ id: 'm1' as never, name: 'm1', host: 'h', user: 'u', port: 22, remotePort: 3089, startCommand: 'my-own-dsh --port 1' })
    expect(command).toContain('my-own-dsh --port 1')
    expect(command).not.toContain('--use-system-ca')
  })
})
