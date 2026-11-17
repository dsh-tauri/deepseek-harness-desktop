import type { RemoteExecResult, RemoteSession } from '../types/index'
import type { DshVersionInstallPlan, DshZipPlan, RemoteInstallPlan } from './bootstrap.types'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { GithubHttpError } from '../utils/version'
import { assertRemoteDshVersion, buildCoreVersionInstallScript, buildInstallScript, coreSlotLockShell, planRemoteInstall, planRemoteVersionInstall, readRemoteDshVersion, startCommandFor } from './bootstrap.utils'

async function failing(): Promise<never> {
  throw new Error('network unreachable')
}

function zipPlanOf(plan: RemoteInstallPlan): DshZipPlan {
  if (plan.dsh.kind !== 'pkg-zip')
    throw new Error('expected a pkg-zip install plan')
  return plan.dsh
}

function sessionOfResult(result: RemoteExecResult): RemoteSession {
  return {
    exec: vi.fn(async () => result),
    stream: vi.fn(),
    onClosed: vi.fn(),
    close: vi.fn(async () => {}),
  }
}

describe('远端 DSH 包版本读取', () => {
  it('reads the installed package version', async () => {
    const session = sessionOfResult({ code: 0, stdout: JSON.stringify({ version: '0.2.2-rc.1' }), stderr: '' })
    await expect(readRemoteDshVersion(session)).resolves.toBe('0.2.2-rc.1')
  })

  it('does not treat malformed package metadata as an allowed missing install', async () => {
    const session = sessionOfResult({ code: 0, stdout: 'not json', stderr: '' })
    await expect(assertRemoteDshVersion(session, true)).rejects.toThrow('REMOTE_DSH_PACKAGE_INVALID')
  })

  it('preserves a failed package read as unreadable', async () => {
    const session = sessionOfResult({ code: 1, stdout: '', stderr: 'permission denied' })
    await expect(readRemoteDshVersion(session)).rejects.toThrow('REMOTE_DSH_PACKAGE_UNREADABLE')
  })

  it('allows an explicitly missing package only when requested', async () => {
    const session = sessionOfResult({ code: 0, stdout: 'REMOTE_DSH_MISSING', stderr: '' })
    await expect(assertRemoteDshVersion(session, true)).resolves.toBeUndefined()
    await expect(readRemoteDshVersion(session)).resolves.toBeUndefined()
  })
})

describe('指定版本下载计划', () => {
  it('缺少可信摘要时只保留官方下载源', async () => {
    const plan = await planRemoteVersionInstall('Linux x86_64', {}, 'dsh-0.2.3-43000000000', {
      listAssets: async () => [{ name: 'deepseek-harness-pkg-linux.zip', url: 'https://example.invalid/official.zip' }],
      probe: async () => 'available',
    })

    expect(plan.dsh.kind).toBe('pkg-zip')
    if (plan.dsh.kind !== 'pkg-zip')
      throw new Error('expected a pkg-zip plan')
    expect(plan.dsh.urls).toEqual(['https://example.invalid/official.zip'])
    expect(plan.dsh.digest).toBeUndefined()
  })

  it('资产元数据失败时同样不把镜像加入无摘要计划', async () => {
    const plan = await planRemoteVersionInstall('Linux x86_64', {}, 'dsh-0.2.3-43000000000', {
      listAssets: async () => { throw new Error('rate limited') },
      probe: async () => 'unknown',
    })

    expect(plan.dsh.urls).toHaveLength(1)
  })

  it('npm 包缺少可信摘要时只保留官方下载源', async () => {
    const plan = await planRemoteVersionInstall('Linux aarch64', {}, 'dsh-0.2.3-43000000000', {
      npmDist: async () => ({
        url: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.3.tgz',
        mirrorUrl: 'https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.2.3.tgz',
      }),
    })

    expect(plan.dsh.kind).toBe('npm-tgz')
    if (plan.dsh.kind !== 'npm-tgz')
      throw new Error('expected an npm-tgz plan')
    // 没有摘要时跳过校验：镜像文件不能绕过校验直接被安装。
    expect(plan.dsh.urls).toEqual(['https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.3.tgz'])
    expect(plan.dsh.integrity).toBeUndefined()
  })

  it('npm 取得可信摘要时官方源与镜像源都保留', async () => {
    const plan = await planRemoteVersionInstall('Linux aarch64', {}, 'dsh-0.2.3-43000000000', {
      npmDist: async () => ({
        url: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.3.tgz',
        mirrorUrl: 'https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.2.3.tgz',
        integrity: 'sha512-abc',
      }),
    })

    expect(plan.dsh.kind).toBe('npm-tgz')
    if (plan.dsh.kind !== 'npm-tgz')
      throw new Error('expected an npm-tgz plan')
    expect(plan.dsh.urls).toEqual([
      'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.3.tgz',
      'https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.2.3.tgz',
    ])
    expect(plan.dsh.integrity).toBeDefined()
  })
})

describe('指定版本下载脚本', () => {
  const plan: DshVersionInstallPlan = {
    os: 'linux',
    arch: 'x64',
    repo: 'dsh-tauri/deepseek-harness-pkg',
    tag: 'dsh-0.2.3-43000000000',
    version: '0.2.3',
    dshEntry: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
    dsh: {
      kind: 'pkg-zip',
      urls: ['https://example.invalid/dsh.zip'],
      digest: 'sha256:bb',
      zipName: 'deepseek-harness-pkg-linux.zip',
      tag: 'dsh-0.2.3-43000000000',
    },
    notes: [],
  }

  it('使用独立临时目录，并以入口文件判定副本是否就绪', () => {
    const script = buildCoreVersionInstallScript(plan, { slot: plan.tag })
    expect(script).toContain('TMP="$ROOT/tmp/ver.$$"')
    expect(script).toContain('if [ -f "$SLOT/node_modules/@deepseek-ai/dsh/lib/bin.js" ] && [ -z "$REINSTALL" ]; then')
    expect(script).toContain('flatten_move "$STAGE" "$READY"')
    expect(script).toContain('mv "$READY" "$SLOT"')
  })

  it('暂存与就绪目录按运行隔离，旧脚本的清理不会删掉新安装的文件', () => {
    const script = buildCoreVersionInstallScript(plan, { slot: plan.tag })
    expect(script).toContain('STAGE="$SLOT.new.$$"')
    expect(script).toContain('READY="$SLOT.ready.$$"')
  })

  it('同一槽位只允许一个安装脚本在跑，后到的明确失败', () => {
    const script = buildCoreVersionInstallScript(plan, { slot: plan.tag })
    expect(script).toContain('LOCK="$ROOT/tmp/slot-dsh-0.2.3-43000000000.lock"')
    expect(script).toContain('REMOTE_CORE_SLOT_BUSY')
    // 锁必须原子发布持有者：先写好 pid，再用一次 ln 把锁挂出去。
    // 不能先建目录再补写 pid —— 那中间后到的脚本会读到空持有者，把活锁当陈旧锁接管。
    expect(script).not.toContain('mkdir "$LOCK"')
    expect(script.indexOf('printf \'%s\\n\' "$$" > "$LOCKOWNER"')).toBeLessThan(script.indexOf('ln "$LOCKOWNER" "$LOCK"'))
    expect(script.indexOf('ln "$LOCKOWNER" "$LOCK"')).toBeLessThan(script.indexOf('trap cleanup EXIT'))
    // 陈旧锁的接管也要原子：先换走旧锁再抢，抢不到就明确失败。
    expect(script).toContain('mv "$LOCK" "$TMP/stale-lock.$$" 2>/dev/null || true')
    // 退出清理只删自己仍然持有的锁。
    expect(script).toContain('if [ "$(cat "$LOCK" 2>/dev/null || true)" = "$$" ]; then rm -f "$LOCK"; fi')
  })

  it('发布时先换走旧槽位再 rename 就绪目录', () => {
    const script = buildCoreVersionInstallScript(plan, { slot: plan.tag })
    expect(script).toContain('if [ -e "$SLOT" ]; then')
    expect(script).toContain('mv "$SLOT" "$TMP/replaced"')
    expect(script).toContain('mv "$READY" "$SLOT"')
    // 不能是「先删槽位再移动」：新旧脚本交错时会把就绪目录移进已有槽位。
    expect(script).not.toContain('rm -rf "$SLOT"')
  })

  it('npm 依赖在暂存目录安装成功后才发布槽位', () => {
    const script = buildCoreVersionInstallScript({
      ...plan,
      arch: 'arm64',
      dshEntry: 'lib/bin.js',
      dsh: {
        kind: 'npm-tgz',
        urls: ['https://example.invalid/dsh.tgz'],
        integrity: 'sha256:cc',
        packageName: '@deepseek-ai/dsh',
        version: plan.version,
      },
    }, { slot: plan.tag })

    expect(script).toContain('install_dsh_deps "$STAGE" || { rm -rf "$STAGE"; exit 13; }')
    expect(script.indexOf('install_dsh_deps "$STAGE"')).toBeLessThan(script.indexOf('mv "$READY" "$SLOT"'))
  })
})

describe('远端槽位锁的并发行为', () => {
  const SHELL_AVAILABLE = spawnSync('sh', ['-c', 'command -v ln >/dev/null 2>&1 && command -v kill >/dev/null 2>&1']).status === 0
  const slot = 'dsh-test'

  function lockPath(home: string): string {
    return join(home, '.dsh-desktop', 'tmp', `slot-${slot}.lock`)
  }

  /** 用生产代码生成的锁片段搭一段可执行脚本，锁之外的变量与正式脚本保持一致。 */
  function lockScript(before: string[] = [], after: string[] = []): string {
    return [
      'set -eu',
      'ROOT="$HOME/.dsh-desktop"',
      'TMP="$ROOT/tmp/ver.$$"',
      'SLOT="$ROOT/dependencies/dsh-test"',
      'STAGE="$SLOT.new.$$"',
      'READY="$SLOT.ready.$$"',
      'mkdir -p "$ROOT/dependencies" "$TMP"',
      'log() { printf \'log %s %s\\n\' "$1" "$2"; }',
      ...before,
      ...coreSlotLockShell(slot),
      'trap cleanup EXIT',
      ...after,
    ].join('\n')
  }

  function runLock(home: string, before: string[] = [], after: string[] = []): { code: number | null, output: string } {
    const result = spawnSync('sh', ['-c', lockScript(before, after)], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    })
    return { code: result.status, output: `${result.stdout}${result.stderr}` }
  }

  function spawnLock(home: string, before: string[] = [], after: string[] = []): Promise<{ code: number | null, output: string }> {
    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', lockScript(before, after)], { env: { ...process.env, HOME: home } })
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        output += String(chunk)
      })
      child.on('close', code => resolve({ code, output }))
    })
  }

  async function waitForFile(path: string): Promise<boolean> {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (existsSync(path))
        return true
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return false
  }

  /** 拿一个已经退出的进程号，用它伪造被强杀留下的陈旧锁。 */
  async function deadPid(): Promise<number> {
    const child = spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' })
    await new Promise(resolve => child.on('close', resolve))
    return child.pid ?? 0
  }

  it.skipIf(!SHELL_AVAILABLE)('持锁者还在跑时，后到的安装明确失败而不是接管', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-slot-lock-'))
    const holder = spawn('sh', ['-c', lockScript([], ['sleep 5'])], { env: { ...process.env, HOME: home }, stdio: 'ignore' })
    try {
      expect(await waitForFile(lockPath(home))).toBe(true)
      // 锁一旦出现就必须带着持有者 pid：不存在「锁已存在但持有者未知」的窗口，
      // 否则后到的脚本会把还在跑的安装当成陈旧锁接管，两个脚本同时发布同一槽位。
      const owner = readFileSync(lockPath(home), 'utf8').trim()
      expect(owner).toMatch(/^\d+$/)
      expect(() => process.kill(Number(owner), 0)).not.toThrow()

      const contender = runLock(home)
      expect(contender.code).toBe(17)
      expect(contender.output).toContain('REMOTE_CORE_SLOT_BUSY')
    }
    finally {
      holder.kill()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.skipIf(!SHELL_AVAILABLE)('两个脚本同时接管同一把陈旧锁时只有一个能装上', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-slot-lock-'))
    try {
      mkdirSync(join(home, '.dsh-desktop', 'tmp'), { recursive: true })
      writeFileSync(lockPath(home), `${await deadPid()}\n`)
      // 栅栏：两个脚本都等到同一个信号才去抢锁，确保真的撞在一起。
      const ready = (name: string): string[] => [
        `printf 'ready\\n' > "$HOME/ready-${name}"`,
        'while [ ! -e "$HOME/go" ]; do sleep 0.05; done',
      ]
      const first = spawnLock(home, ready('1'), ['sleep 2'])
      const second = spawnLock(home, ready('2'), ['sleep 2'])
      expect(await waitForFile(join(home, 'ready-1'))).toBe(true)
      expect(await waitForFile(join(home, 'ready-2'))).toBe(true)
      writeFileSync(join(home, 'go'), 'go\n')

      const results = await Promise.all([first, second])
      const succeeded = results.filter(result => result.code === 0)
      const failed = results.filter(result => result.code === 17)
      expect(succeeded).toHaveLength(1)
      expect(failed).toHaveLength(1)
      expect(failed[0].output).toContain('REMOTE_CORE_SLOT_BUSY')
    }
    finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.skipIf(!SHELL_AVAILABLE)('持有者退出后锁被释放，下一次安装能继续', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-slot-lock-'))
    try {
      expect(runLock(home).code).toBe(0)
      expect(existsSync(lockPath(home))).toBe(false)
      expect(runLock(home).code).toBe(0)
    }
    finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.skipIf(!SHELL_AVAILABLE)('旧版本留下的目录形态锁仍按占用处理', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-slot-lock-'))
    try {
      mkdirSync(lockPath(home), { recursive: true })
      const holder = spawn('sh', ['-c', 'sleep 5'], { stdio: 'ignore' })
      try {
        writeFileSync(join(lockPath(home), 'pid'), `${holder.pid}\n`)
        const contender = runLock(home)
        expect(contender.code).toBe(17)
        expect(contender.output).toContain('REMOTE_CORE_SLOT_BUSY')
      }
      finally {
        holder.kill()
      }

      // 持有者已经不在时，目录形态的陈旧锁同样要被接管。
      writeFileSync(join(lockPath(home), 'pid'), `${await deadPid()}\n`)
      expect(runLock(home).code).toBe(0)
    }
    finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

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

  it('bootstrap 计划的 npm 包缺少可信摘要时只保留官方下载源', async () => {
    const plan = await planRemoteInstall('Linux aarch64', {}, {
      listReleases: async () => [{ tag: 'dsh-0.2.3-43000000000', prerelease: false }],
      npmDist: async () => ({
        url: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.3.tgz',
        mirrorUrl: 'https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.2.3.tgz',
      }),
    })

    expect(plan.dsh.kind).toBe('npm-tgz')
    if (plan.dsh.kind !== 'npm-tgz')
      throw new Error('expected an npm-tgz plan')
    // 没有摘要时跳过校验：镜像文件不能绕过校验直接被安装。
    expect(plan.dsh.urls).toEqual(['https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.3.tgz'])
  })

  it('bootstrap 计划的 npm 包取得可信摘要时保留官方源与镜像源', async () => {
    const plan = await planRemoteInstall('Linux aarch64', {}, {
      listReleases: async () => [{ tag: 'dsh-0.2.3-43000000000', prerelease: false }],
      npmDist: async () => ({
        url: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.3.tgz',
        mirrorUrl: 'https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.2.3.tgz',
        integrity: 'sha512-abc',
      }),
    })

    expect(plan.dsh.kind).toBe('npm-tgz')
    if (plan.dsh.kind !== 'npm-tgz')
      throw new Error('expected an npm-tgz plan')
    expect(plan.dsh.urls).toEqual([
      'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.3.tgz',
      'https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.2.3.tgz',
    ])
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
