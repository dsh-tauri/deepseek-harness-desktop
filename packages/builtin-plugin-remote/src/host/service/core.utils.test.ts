import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCoreSwitchRestoreScript, buildCoreSwitchScript, parseRemoteCopies, remoteCopiesProbeCommand } from './core.utils'

const homes: string[] = []
const SWITCH_PORT = 38471

function fixtureHome(): { home: string, deps: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-core-switch-'))
  homes.push(home)
  const deps = join(home, '.dsh-desktop', 'dependencies')
  mkdirSync(join(deps, 'dsh'), { recursive: true })
  mkdirSync(join(deps, 'dsh-new'), { recursive: true })
  writeFileSync(join(deps, 'dsh', 'version'), 'old')
  writeFileSync(join(deps, 'dsh-new', 'version'), 'new')
  writeFileSync(join(deps, '.active-tag'), 'dsh-old\n')
  return { home, deps }
}

function runScript(home: string, script: string, path?: string, extraEnv?: Record<string, string>): ReturnType<typeof spawnSync> {
  return spawnSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...path === undefined ? {} : { PATH: `${path}:${process.env.PATH ?? ''}` }, ...extraEnv },
  })
}

/**
 * 拉起一个只会应答端口的假远端实例：切换脚本要等端口应声才算就绪。
 *
 * 进程号要记下来：上游的停实例命令会确认端口腾空才肯继续，
 * 上一个用例留下的监听没被收走，后一个用例就会停不掉「旧实例」。
 */
function listenerStartCommand(): string {
  return `( node -e 'require("http").createServer((_, res) => res.end("ok")).listen(${SWITCH_PORT})' </dev/null >/dev/null 2>&1 & echo $! > "$HOME/listener.pid" )`
}

function switchScript(overrides: { backupTag?: string, startCommand?: string, healthPollAttempts?: number, activeVersion?: string, targetVersion?: string, remotePort?: number } = {}): string {
  return buildCoreSwitchScript({
    targetTag: 'dsh-new',
    backupTag: overrides.backupTag ?? 'dsh-old',
    runId: 'test',
    profileName: 'remote',
    remotePort: overrides.remotePort ?? SWITCH_PORT,
    startCommand: overrides.startCommand ?? listenerStartCommand(),
    entryRelativePath: 'lib/bin.js',
    healthPollAttempts: overrides.healthPollAttempts ?? 20,
    healthPollIntervalMs: 500,
    ...overrides.activeVersion === undefined ? {} : { activeVersion: overrides.activeVersion },
    ...overrides.targetVersion === undefined ? {} : { targetVersion: overrides.targetVersion },
  })
}

/** 杀掉上一个用例留下的监听进程：端口被占会让后一个用例的探测假成功。 */
function killListener(home: string): void {
  const pidFile = join(home, 'listener.pid')
  if (!existsSync(pidFile))
    return
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  if (Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid)
    }
    catch {
      // 已经退出
    }
  }
}

function completeCopy(deps: string, name: string, version: string): void {
  const dir = join(deps, name)
  mkdirSync(join(dir, 'node_modules/@deepseek-ai/dsh/lib'), { recursive: true })
  writeFileSync(join(dir, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '')
  writeFileSync(join(dir, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ version }))
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    killListener(home)
    rmSync(home, { recursive: true, force: true })
  }
})

describe('remote core switch scripts', () => {
  it('records the active tag from the remote dependencies directory', () => {
    const copies = parseRemoteCopies([
      '__DSH_ACTIVE_TAG__dsh-0.2.3-43000000000',
      '__DSH_COPY__dsh',
      '__DSH_DIR__/home/remote/.dsh-desktop/dependencies/dsh',
      '__DSH_ENTRY__/home/remote/.dsh-desktop/dependencies/dsh/lib/bin.js',
      '__DSH_PKG_BEGIN__',
      '{"version":"0.2.3"}',
      '__DSH_PKG_END__',
    ].join('\n'))

    expect(copies).toEqual([{
      name: 'dsh',
      dir: '/home/remote/.dsh-desktop/dependencies/dsh',
      entry: '/home/remote/.dsh-desktop/dependencies/dsh/lib/bin.js',
      tag: 'dsh-0.2.3-43000000000',
      version: '0.2.3',
    }])
  })

  it('swaps the active and downloaded directories and writes the new active tag', () => {
    const { home, deps } = fixtureHome()

    const result = runScript(home, switchScript())
    expect(result.status).toBe(0)
    expect(readFileSync(join(deps, 'dsh', 'version'), 'utf8')).toBe('new')
    expect(readFileSync(join(deps, 'dsh-old', 'version'), 'utf8')).toBe('old')
    expect(readFileSync(join(deps, '.active-tag'), 'utf8')).toBe('dsh-new\n')
    expect(() => readFileSync(join(deps, 'dsh-new', 'version'))).toThrow()
  })

  it('leaves the active tag alone when another desktop wrote it before the switch was refused', () => {
    const { home, deps } = fixtureHome()
    const bin = join(home, 'bin')
    mkdirSync(bin)
    // 假 mkdir：占用槽位时（版本记录快照之后）别的桌面写入了新的版本记录。
    writeFileSync(join(bin, 'mkdir'), `#!/bin/sh\ncase "$*" in\n  *slot-*) printf 'dsh-other\\n' > "${join(deps, '.active-tag')}" ;;\nesac\nexec /bin/mkdir "$@"\n`)
    chmodSync(join(bin, 'mkdir'), 0o755)

    // 版本核对不通过：脚本在停机前就拒绝，这次切换没动过远端状态。
    const result = runScript(home, switchScript({ activeVersion: '9.9.9' }), bin)
    expect(result.status).not.toBe(0)
    // 别人的版本记录不能被写回旧值。
    expect(readFileSync(join(deps, '.active-tag'), 'utf8')).toBe('dsh-other\n')
    expect(readFileSync(join(deps, 'dsh', 'version'), 'utf8')).toBe('old')
  })

  it('refuses to restore the old core when the target position was taken', () => {
    const { home, deps } = fixtureHome()
    // 切换已经成功：活动目录是新核心，旧核心在备份槽位里。
    writeFileSync(join(deps, 'dsh', 'version'), 'new')
    mkdirSync(join(deps, 'dsh-old'), { recursive: true })
    writeFileSync(join(deps, 'dsh-old', 'version'), 'old')
    // 目标位置被别人重新填上了：这时恢复会把新核心当成旧核心。
    mkdirSync(join(deps, 'dsh-new'), { recursive: true })

    const result = runScript(home, buildCoreSwitchRestoreScript({
      targetTag: 'dsh-new',
      backupTag: 'dsh-old',
      runId: 'restore',
      profileName: 'remote',
      remotePort: SWITCH_PORT,
      startCommand: listenerStartCommand(),
      healthPollAttempts: 20,
      healthPollIntervalMs: 500,
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('REMOTE_CORE_SWITCH_UNRECOVERED')
    // 没恢复就不能写回版本记录。
    expect(readFileSync(join(deps, '.active-tag'), 'utf8')).toBe('dsh-old\n')
  })

  it.skipIf(process.platform === 'win32')('keeps the old core active when moving the target into place fails', () => {
    const { home, deps } = fixtureHome()
    const bin = join(home, 'bin')
    mkdirSync(bin)
    const mv = join(bin, 'mv')
    writeFileSync(mv, `#!/bin/sh\nif [ "$1" = "${join(deps, 'dsh-new')}" ] && [ "$2" = "${join(deps, 'dsh')}" ]; then exit 1; fi\nexec /bin/mv "$@"\n`)
    chmodSync(mv, 0o755)

    const result = runScript(home, switchScript(), bin)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('REMOTE_CORE_SWITCH_FAILED')
    expect(result.stderr).not.toContain('REMOTE_CORE_SWITCH_UNRECOVERED')
    expect(readFileSync(join(deps, 'dsh', 'version'), 'utf8')).toBe('old')
    expect(readFileSync(join(deps, 'dsh-new', 'version'), 'utf8')).toBe('new')
    expect(readFileSync(join(deps, '.active-tag'), 'utf8')).toBe('dsh-old\n')
  })

  it.skipIf(process.platform === 'win32')('reports an unrecovered switch when the old core cannot be restored', () => {
    const { home, deps } = fixtureHome()
    const bin = join(home, 'bin')
    mkdirSync(bin)
    const mv = join(bin, 'mv')
    // 换回去也失败：这时旧核心没恢复，必须和普通失败区分开。
    writeFileSync(mv, `#!/bin/sh\nif [ "$2" = "${join(deps, 'dsh')}" ] || [ "$1" = "${join(deps, 'dsh-old')}" ]; then exit 1; fi\nexec /bin/mv "$@"\n`)
    chmodSync(mv, 0o755)

    const result = runScript(home, switchScript(), bin)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('REMOTE_CORE_SWITCH_UNRECOVERED')
  })

  it.skipIf(process.platform === 'win32')('restores the old core and its tag when the instance cannot be started', () => {
    const { home, deps } = fixtureHome()

    // 拉起命令自己 exit 1：它必须被接住，不能把目录留在换了一半的状态。
    const result = runScript(home, switchScript({ startCommand: 'echo "REMOTE_NOT_INSTALLED: 远端三件套未安装完整"; exit 1' }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('REMOTE_CORE_SWITCH_FAILED')
    expect(result.stderr).not.toContain('REMOTE_CORE_SWITCH_UNRECOVERED')
    expect(readFileSync(join(deps, 'dsh', 'version'), 'utf8')).toBe('old')
    expect(readFileSync(join(deps, 'dsh-new', 'version'), 'utf8')).toBe('new')
    // 版本记录也要跟着目录换回去，否则清单会把旧核心标成新版本。
    expect(readFileSync(join(deps, '.active-tag'), 'utf8')).toBe('dsh-old\n')
  })

  it.skipIf(process.platform === 'win32')('accepts a health check that only succeeds on the last attempt', () => {
    const { home } = fixtureHome()
    // 探测一次就成功：计数刚好用尽，但不是超时。
    const startCommand = `( node -e 'require("http").createServer((_, res) => res.end("ok")).listen(${SWITCH_PORT})' </dev/null >/dev/null 2>&1 & echo $! > "$HOME/listener.pid" ); sleep 1`

    try {
      const result = runScript(home, switchScript({ startCommand, healthPollAttempts: 1 }))
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('REMOTE_CORE_SWITCH_READY')
    }
    finally {
      killListener(home)
    }
  })

  it.skipIf(process.platform === 'win32')('stops the instance it started before restoring the old core', () => {
    const { home, deps } = fixtureHome()
    writeFileSync(join(home, 'bin.js'), 'setInterval(() => {}, 1000)\n')
    // 实例参数要带上档案名与端口，停止命令才匹配得上；
    // 脚本文本里只放变量引用，免得脚本把自己的命令行也匹配上、被 pkill 掉。
    const startCommand = `( node "$HOME/bin.js" --profile "$DSH_TEST_PROFILE" --host 127.0.0.1 --port "$DSH_TEST_PORT" </dev/null >/dev/null 2>&1 & )`

    const result = runScript(home, switchScript({ startCommand, healthPollAttempts: 1, remotePort: SWITCH_PORT + 1 }), undefined, {
      DSH_TEST_PROFILE: 'remote',
      DSH_TEST_PORT: String(SWITCH_PORT + 1),
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('REMOTE_CORE_SWITCH_FAILED')
    // 目录与版本记录都换回旧核心。
    expect(readFileSync(join(deps, 'dsh', 'version'), 'utf8')).toBe('old')
    expect(readFileSync(join(deps, '.active-tag'), 'utf8')).toBe('dsh-old\n')
    // 本次拉起的实例必须已经停掉：不然恢复出来的旧核心旁边还挂着一个新核心。
    const alive = spawnSync('sh', ['-c', `ps -eo args= | grep -F "bin.js --profile remote --host 127.0.0.1 --port ${SWITCH_PORT + 1}" | grep -v grep || true`], { encoding: 'utf8' })
    expect(alive.stdout.trim()).toBe('')
  })

  it.skipIf(process.platform === 'win32')('refuses to switch when the active copy changed after the probe', () => {
    const { home, deps } = fixtureHome()
    writeFileSync(join(deps, 'dsh', 'package.json'), JSON.stringify({ version: '0.2.9' }))
    writeFileSync(join(deps, 'dsh-new', 'package.json'), JSON.stringify({ version: '0.2.3' }))

    const result = runScript(home, switchScript({ activeVersion: '0.2.2-rc.1', targetVersion: '0.2.3' }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('当前使用的核心已变化')
    // 没停实例、没动目录。
    expect(readFileSync(join(deps, 'dsh', 'version'), 'utf8')).toBe('old')
    expect(readFileSync(join(deps, 'dsh-new', 'version'), 'utf8')).toBe('new')
  })

  it.skipIf(process.platform === 'win32')('refuses to switch while the backup slot is taken', () => {
    const { home, deps } = fixtureHome()
    mkdirSync(join(deps, 'dsh-old'), { recursive: true })
    writeFileSync(join(deps, 'dsh-old', 'version'), 'downloaded')

    const result = runScript(home, switchScript())

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('备份槽位已被占用')
    // 别人的副本不能被挪走或删掉。
    expect(readFileSync(join(deps, 'dsh-old', 'version'), 'utf8')).toBe('downloaded')
    expect(readFileSync(join(deps, 'dsh', 'version'), 'utf8')).toBe('old')
    expect(readFileSync(join(deps, 'dsh-new', 'version'), 'utf8')).toBe('new')
  })

  it.skipIf(process.platform === 'win32')('refuses to switch while the target slot is taken', () => {
    const { home, deps } = fixtureHome()
    const lock = join(home, '.dsh-desktop', 'tmp', 'slot-dsh-new.lock')
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, `claim-${process.pid}`), `${process.pid}\n`)

    const result = runScript(home, switchScript())

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('REMOTE_CORE_SLOT_BUSY')
    expect(readFileSync(join(deps, 'dsh', 'version'), 'utf8')).toBe('old')
    expect(readFileSync(join(deps, 'dsh-new', 'version'), 'utf8')).toBe('new')
  })

  it.skipIf(process.platform === 'win32')('refuses to switch while the active slot is taken', () => {
    const { home, deps } = fixtureHome()
    const lock = join(home, '.dsh-desktop', 'tmp', 'slot-dsh.lock')
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, `claim-${process.pid}`), `${process.pid}\n`)

    const result = runScript(home, switchScript())

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('REMOTE_CORE_SLOT_BUSY')
    expect(readFileSync(join(deps, 'dsh', 'version'), 'utf8')).toBe('old')
    expect(readFileSync(join(deps, 'dsh-new', 'version'), 'utf8')).toBe('new')
  })

  it.skipIf(process.platform === 'win32')('refuses to switch while the backup slot is claimed by another task', () => {
    const { home, deps } = fixtureHome()
    const lock = join(home, '.dsh-desktop', 'tmp', 'slot-dsh-old.lock')
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, `claim-${process.pid}`), `${process.pid}\n`)

    const result = runScript(home, switchScript())

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('REMOTE_CORE_SLOT_BUSY')
    expect(readFileSync(join(deps, 'dsh', 'version'), 'utf8')).toBe('old')
  })
})

describe('remote core copy probe', () => {
  it('skips staging directories and directories without a core entry', () => {
    const { home, deps } = fixtureHome()
    completeCopy(deps, 'dsh', '0.2.2-rc.1')
    completeCopy(deps, 'dsh-0.2.3-1.new', '0.2.3')
    // 安装脚本的暂存与就绪目录带运行级后缀，同样不能被当成一个副本。
    completeCopy(deps, 'dsh-0.2.3-1.new.4242', '0.2.3')
    completeCopy(deps, 'dsh-0.2.3-1.ready.4242', '0.2.3')
    mkdirSync(join(deps, 'dsh-broken'))

    const result = spawnSync('sh', ['-c', remoteCopiesProbeCommand()], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    })

    expect(result.status).toBe(0)
    expect(parseRemoteCopies(result.stdout).map(copy => copy.name)).toEqual(['dsh'])
  })
})
