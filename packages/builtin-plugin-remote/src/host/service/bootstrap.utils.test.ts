import type { RemoteExecResult, RemoteSession } from '../types/index'
import type { DshVersionInstallPlan, DshZipPlan, RemoteInstallPlan } from './bootstrap.types'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { remoteSlotClaimShell } from '../utils/instance'
import { GithubHttpError } from '../utils/version'
import { assertRemoteDshVersion, buildCoreVersionInstallScript, buildInstallScript, planRemoteInstall, planRemoteVersionInstall, readRemoteDshVersion, remoteWebTokenCommand, startCommandFor } from './bootstrap.utils'

const SHELL_AVAILABLE = spawnSync('sh', ['-c', 'command -v ln >/dev/null 2>&1 && command -v kill >/dev/null 2>&1']).status === 0

const LOCK_TEST_SLOT = 'dsh-test'

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
    ...remoteSlotClaimShell(LOCK_TEST_SLOT),
    'cleanup() { rm -rf "$TMP"; rm -f "$CLAIM"; }',
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

describe('远端实例启动令牌', () => {
  function tokenOf(home: string, port: number): string {
    const result = spawnSync('sh', ['-c', remoteWebTokenCommand(port)], { encoding: 'utf8', env: { ...process.env, HOME: home } })
    return result.stdout.trim()
  }

  function homeWith(files: Record<string, string>): string {
    const home = mkdtempSync(join(tmpdir(), 'dsh-web-token-'))
    mkdirSync(join(home, '.dsh'), { recursive: true })
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(home, '.dsh', name), content)
    return home
  }

  it('实例日志按端口分文件，取令牌只读这个端口那一份', () => {
    const home = homeWith({
      'dsh-remote-web-41990.log': 'dsh web: http://127.0.0.1:41990/?token=token-a\n',
      'dsh-remote-web-41991.log': 'dsh web: http://127.0.0.1:41991/?token=token-b\n',
    })

    expect(tokenOf(home, 41990)).toBe('token-a')
    expect(tokenOf(home, 41991)).toBe('token-b')
  })

  it('旧版桌面写的整机日志按端口过滤，不取别的实例的令牌', () => {
    const home = homeWith({
      'dsh-remote-web.log': 'dsh web: http://127.0.0.1:41991/?token=token-b\ndsh web: http://127.0.0.1:41990/?token=token-a\n',
    })

    expect(tokenOf(home, 41990)).toBe('token-a')
    expect(tokenOf(home, 41992)).toBe('')
  })

  it('整机日志里只有一枚令牌时用它', () => {
    const home = homeWith({
      'dsh-remote-web.log': 'dsh web: https://dsh.example.com/?token=only-one\n',
    })

    expect(tokenOf(home, 41990)).toBe('only-one')
  })

  it('整机日志里有多个实例的令牌时不去猜', () => {
    const home = homeWith({
      'dsh-remote-web.log': 'dsh web: https://a.example.com/?token=token-a\ndsh web: https://b.example.com/?token=token-b\n',
    })

    expect(tokenOf(home, 41990)).toBe('')
  })

  it('实例的日志与 pidfile 都按端口命名', () => {
    const profile = { id: 'm1', name: '远端机器', host: '127.0.0.1', port: 22, user: 'tester', remotePort: 41990, profileName: 'remote' } as never
    const script = startCommandFor(profile)

    expect(script).toContain('dsh-remote-web-41990.log')
    expect(script).toContain('.dsh/.dsh-remote-41990.pid')
  })
})

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
    expect(script).toContain('LOCKDIR="$ROOT/tmp/slot-dsh-0.2.3-43000000000.lock"')
    expect(script).toContain('CLAIM="$LOCKDIR/claim-$$"')
    expect(script).toContain('REMOTE_CORE_SLOT_BUSY')
    // 占用声明与持有者 pid 一起原子发布：先写好 pid，再用一次 ln 把声明挂出去。
    expect(script.indexOf('printf \'%s\\n\' "$$" > "$TMP/claim.$$"')).toBeLessThan(script.indexOf('ln "$TMP/claim.$$" "$CLAIM"'))
    expect(script.indexOf('ln "$TMP/claim.$$" "$CLAIM"')).toBeLessThan(script.indexOf('trap cleanup EXIT'))
    // 锁目录本身绝不能被整体搬走或删除：那正是「按先前读到的 pid 移走当前锁」的竞态。
    expect(script).not.toContain('mv "$LOCKDIR"')
    expect(script).not.toContain('rm -rf "$LOCKDIR"')
    // 回收陈旧声明时只删单条声明，不动别人的。
    expect(script).toContain('rm -f "$_f"')
    // 退出清理只删自己的声明。
    expect(script).toContain('cleanup() { rm -rf "$TMP" "$STAGE" "$READY"; rm -f "$CLAIM"; }')
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
  const slot = LOCK_TEST_SLOT

  function lockDir(home: string): string {
    return join(home, '.dsh-desktop', 'tmp', `slot-${slot}.lock`)
  }

  function claimsOf(home: string): string[] {
    try {
      return readdirSync(lockDir(home)).filter(name => name.startsWith('claim-'))
    }
    catch {
      return []
    }
  }

  function spawnLock(home: string, before: string[] = [], after: string[] = [], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null, output: string }> {
    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', lockScript(before, after)], { env: { ...process.env, HOME: home, ...env } })
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

  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate())
        return true
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return false
  }

  /** 拿一个已经退出的进程号，用它伪造被强杀留下的陈旧声明。 */
  async function deadPid(): Promise<number> {
    const child = spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' })
    await new Promise(resolve => child.on('close', resolve))
    return child.pid ?? 0
  }

  it.skipIf(!SHELL_AVAILABLE)('持锁者还在跑时，后到的安装明确失败而不是接管', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-slot-lock-'))
    const holder = spawn('sh', ['-c', lockScript([], ['sleep 5'])], { env: { ...process.env, HOME: home }, stdio: 'ignore' })
    try {
      expect(await waitFor(() => claimsOf(home).length > 0)).toBe(true)
      // 声明一旦出现就必须带着持有者 pid：不存在「声明已在但持有者未知」的窗口，
      // 否则后到的脚本会把还在跑的安装当成陈旧声明清掉，两个脚本同时发布同一槽位。
      const owner = readFileSync(join(lockDir(home), claimsOf(home)[0]!), 'utf8').trim()
      expect(owner).toMatch(/^\d+$/)
      expect(() => process.kill(Number(owner), 0)).not.toThrow()

      const contender = runLock(home)
      expect(contender.code).toBe(17)
      expect(contender.output).toContain('REMOTE_CORE_SLOT_BUSY')
      // 失败的一方不能把持有者的声明删掉。
      expect(claimsOf(home)).toHaveLength(1)
    }
    finally {
      holder.kill()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.skipIf(!SHELL_AVAILABLE)('两个脚本同时抢同一个槽位时最多只有一个能装上', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-slot-lock-'))
    try {
      // 栅栏：两个脚本都等到同一个信号才去抢锁，确保真的撞在一起。
      const ready = (name: string): string[] => [
        `printf 'ready\\n' > "$HOME/ready-${name}"`,
        'while [ ! -e "$HOME/go" ]; do sleep 0.05; done',
      ]
      const first = spawnLock(home, ready('1'), ['sleep 2'])
      const second = spawnLock(home, ready('2'), ['sleep 2'])
      expect(await waitFor(() => existsSync(join(home, 'ready-1')) && existsSync(join(home, 'ready-2')))).toBe(true)
      writeFileSync(join(home, 'go'), 'go\n')

      const results = await Promise.all([first, second])
      // 互斥的底线：两个脚本绝不能同时认为自己拿到了槽位。
      expect(results.filter(result => result.code === 0).length).toBeLessThanOrEqual(1)
      for (const result of results.filter(failed => failed.code === 17))
        expect(result.output).toContain('REMOTE_CORE_SLOT_BUSY')
    }
    finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.skipIf(!SHELL_AVAILABLE)('后到的脚本不会把已经接管槽位的脚本的声明删掉', async () => {
    // 用假的 ln 把后到的脚本停在「发布声明」这一步，等先到的脚本接管完再放行。
    const home = mkdtempSync(join(tmpdir(), 'dsh-slot-lock-'))
    const bin = join(home, 'fake-bin')
    mkdirSync(bin, { recursive: true })
    const realLn = spawnSync('sh', ['-c', 'command -v ln'], { encoding: 'utf8' }).stdout.trim()
    writeFileSync(join(bin, 'ln'), [
      '#!/bin/sh',
      'case "$2" in',
      '  */slot-*.lock*)',
      '    printf \'paused\\n\' > "$HOME/ln-paused"',
      '    while [ ! -e "$HOME/ln-go" ]; do sleep 0.05; done',
      '    ;;',
      'esac',
      `exec ${realLn} "$@"`,
    ].join('\n'))
    chmodSync(join(bin, 'ln'), 0o755)
    const path = `${bin}:${process.env.PATH ?? ''}`
    try {
      // 后到的脚本停在发布声明之前。
      const late = spawnLock(home, [], ['sleep 2'], { PATH: path, DSH_TEST_PAUSE_ON_LN: '1' })
      expect(await waitFor(() => existsSync(join(home, 'ln-paused')))).toBe(true)

      // 先到的脚本这时接管槽位并持有。
      const holder = spawn('sh', ['-c', lockScript([], ['sleep 5'])], { env: { ...process.env, HOME: home }, stdio: 'ignore' })
      try {
        expect(await waitFor(() => claimsOf(home).length > 0)).toBe(true)
        const holderClaim = claimsOf(home)[0]!

        // 放行后到的脚本：它必须看到活着的持有者并明确失败，不能把持有者的声明删掉。
        writeFileSync(join(home, 'ln-go'), 'go\n')
        const result = await late
        expect(result.code).toBe(17)
        expect(result.output).toContain('REMOTE_CORE_SLOT_BUSY')
        // 持有者的声明还在：后到的脚本没有按先前读到的 pid 搬走当前的锁。
        expect(claimsOf(home)).toContain(holderClaim)
      }
      finally {
        holder.kill()
      }
    }
    finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.skipIf(!SHELL_AVAILABLE)('回收陈旧声明只删那条声明，不会误伤活着的持有者', async () => {
    // 用假的 rm 把后到的脚本停在「回收陈旧声明」这一步：这时它已经判定旧持有者不在了。
    const home = mkdtempSync(join(tmpdir(), 'dsh-slot-lock-'))
    const bin = join(home, 'fake-bin')
    mkdirSync(bin, { recursive: true })
    const realRm = spawnSync('sh', ['-c', 'command -v rm'], { encoding: 'utf8' }).stdout.trim()
    writeFileSync(join(bin, 'rm'), [
      '#!/bin/sh',
      'if [ -n "$DSH_TEST_PAUSE_ON_RM" ]; then',
      '  case "$*" in',
      '    *slot-*.lock*)',
      '      printf \'paused\\n\' > "$HOME/rm-paused"',
      '      while [ ! -e "$HOME/rm-go" ]; do sleep 0.05; done',
      '      ;;',
      '  esac',
      'fi',
      `exec ${realRm} "$@"`,
    ].join('\n'))
    chmodSync(join(bin, 'rm'), 0o755)
    const path = `${bin}:${process.env.PATH ?? ''}`
    try {
      // 槽位里先留一条持有者已经不在的声明。
      mkdirSync(lockDir(home), { recursive: true })
      const stale = await deadPid()
      writeFileSync(join(lockDir(home), `claim-${stale}`), `${stale}\n`)

      const late = spawnLock(home, [], ['sleep 1'], { PATH: path, DSH_TEST_PAUSE_ON_RM: '1' })
      expect(await waitFor(() => existsSync(join(home, 'rm-paused')))).toBe(true)

      // 这时另一个脚本进来：它必须被后到脚本的存活声明挡住，不能同时装同一个槽位。
      const other = runLock(home)
      expect(other.code).toBe(17)
      expect(other.output).toContain('REMOTE_CORE_SLOT_BUSY')

      // 放行后到的脚本：它只该清掉那条已经死掉的声明，然后正常安装。
      writeFileSync(join(home, 'rm-go'), 'go\n')
      const result = await late
      expect(result.code).toBe(0)
      expect(claimsOf(home).includes(`claim-${stale}`)).toBe(false)
    }
    finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.skipIf(!SHELL_AVAILABLE)('持有者退出后声明被清理，下一次安装能继续', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-slot-lock-'))
    try {
      expect(runLock(home).code).toBe(0)
      expect(claimsOf(home)).toHaveLength(0)
      expect(runLock(home).code).toBe(0)
    }
    finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.skipIf(!SHELL_AVAILABLE)('持有者被强杀留下的陈旧声明不会挡住下一次安装', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-slot-lock-'))
    try {
      mkdirSync(lockDir(home), { recursive: true })
      writeFileSync(join(lockDir(home), `claim-${await deadPid()}`), `${await deadPid()}\n`)
      expect(runLock(home).code).toBe(0)
    }
    finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.skipIf(!SHELL_AVAILABLE)('上一版留下的文件形态锁仍按占用处理', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-slot-lock-'))
    try {
      mkdirSync(join(home, '.dsh-desktop', 'tmp'), { recursive: true })
      const holder = spawn('sh', ['-c', 'sleep 5'], { stdio: 'ignore' })
      try {
        writeFileSync(lockDir(home), `${holder.pid}\n`)
        const contender = runLock(home)
        expect(contender.code).toBe(17)
        expect(contender.output).toContain('REMOTE_CORE_SLOT_BUSY')
      }
      finally {
        holder.kill()
      }

      // 持有者已经不在时，上一版留下的文件形态锁要被清掉，不能挡住新的安装。
      writeFileSync(lockDir(home), `${await deadPid()}\n`)
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

  it('bootstrap 的临时目录与版本安装的临时目录、槽位锁分开', () => {
    const script = buildInstallScript(zipPlan())
    // 退出清理只删自己的临时目录：不能扫掉版本安装的临时目录和槽位锁。
    expect(script).toContain('TMP="$ROOT/tmp/bootstrap.$$"')
    expect(script).not.toContain('TMP="$ROOT/tmp"')
    expect(script).toContain('cleanup() { rm -rf "$TMP"; if [ -f "$CLAIM" ]; then rm -rf "$ROOT/runtime.new" "$ROOT/dependencies/pnpm.new" "$ROOT/dependencies/dsh.new"; fi; rm -f "$CLAIM"; }')
  })

  it.skipIf(!SHELL_AVAILABLE)('拿不到占用声明时不得删别人正在写的暂存目录', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-staging-'))
    const holder = spawn('sh', ['-c', 'sleep 30'], { stdio: 'ignore' })
    try {
      // 别人持有活动槽位，并且正在写固定名字的暂存目录。
      const claim = join(home, '.dsh-desktop', 'tmp', 'slot-dsh.lock')
      mkdirSync(claim, { recursive: true })
      writeFileSync(join(claim, `claim-${holder.pid}`), `${holder.pid}\n`)
      const staging = join(home, '.dsh-desktop', 'dependencies', 'dsh.new')
      mkdirSync(staging, { recursive: true })
      writeFileSync(join(staging, 'marker'), 'in progress')

      const result = spawnSync('sh', ['-c', buildInstallScript(zipPlan())], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
        timeout: 60_000,
      })

      expect(result.status, '槽位被占时装不上').not.toBe(0)
      expect(existsSync(join(staging, 'marker')), '别人的暂存目录不能被退出清理删掉').toBe(true)
    }
    finally {
      holder.kill('SIGKILL')
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.skipIf(!SHELL_AVAILABLE)('bootstrap 退出清理不会删掉版本安装的临时目录和槽位锁', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-tmp-'))
    const holder = spawn('sh', ['-c', 'sleep 30'], { stdio: 'ignore' })
    try {
      // 造出版本安装正在用的临时目录与活着的锁声明。
      const tmp = join(home, '.dsh-desktop', 'tmp')
      mkdirSync(join(tmp, 'ver.999'), { recursive: true })
      const claim = join(tmp, `slot-${LOCK_TEST_SLOT}.lock`, `claim-${holder.pid}`)
      mkdirSync(join(tmp, `slot-${LOCK_TEST_SLOT}.lock`), { recursive: true })
      writeFileSync(claim, `${holder.pid}\n`)
      // 上一次崩溃留下的 bootstrap 临时目录：持有者进程已经不在，应当被清掉。
      mkdirSync(join(tmp, 'bootstrap.999999'), { recursive: true })

      // bootstrap 会因为拉不到 node 而失败，但退出清理照常执行。
      const result = spawnSync('sh', ['-c', buildInstallScript(zipPlan())], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
        timeout: 60_000,
      })
      expect(result.status).not.toBe(0)

      expect(existsSync(join(tmp, 'ver.999'))).toBe(true)
      expect(existsSync(claim)).toBe(true)
      expect(existsSync(join(tmp, 'bootstrap.999999'))).toBe(false)

      // 持有者的声明没被清理掉：同槽位的竞争者仍然要看到占用。
      const contender = runLock(home)
      expect(contender.code).toBe(17)
      expect(contender.output).toContain('REMOTE_CORE_SLOT_BUSY')
    }
    finally {
      holder.kill()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.skipIf(!SHELL_AVAILABLE)('拿不到锁时不留下临时目录', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-slot-tmp-'))
    const holder = spawn('sh', ['-c', 'sleep 30'], { stdio: 'ignore' })
    try {
      // 槽位被一个活着的持有者占住。
      const tmp = join(home, '.dsh-desktop', 'tmp')
      mkdirSync(join(tmp, `slot-${LOCK_TEST_SLOT}.lock`), { recursive: true })
      writeFileSync(join(tmp, `slot-${LOCK_TEST_SLOT}.lock`, `claim-${holder.pid}`), `${holder.pid}\n`)

      // 后到的脚本拿不到锁：它在注册退出清理之前就退出了，得自己收尾。
      const contender = runLock(home)
      expect(contender.code).toBe(17)
      expect(contender.output).toContain('REMOTE_CORE_SLOT_BUSY')
      expect(readdirSync(tmp).filter(name => name.startsWith('ver.'))).toHaveLength(0)
      // 别人的声明不能被删掉。
      expect(existsSync(join(tmp, `slot-${LOCK_TEST_SLOT}.lock`, `claim-${holder.pid}`))).toBe(true)
    }
    finally {
      holder.kill()
      rmSync(home, { recursive: true, force: true })
    }
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
