import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCoreSwitchScript, parseRemoteCopies, remoteCopiesProbeCommand } from './core.utils'

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

function runScript(home: string, script: string, path?: string): ReturnType<typeof spawnSync> {
  return spawnSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...path === undefined ? {} : { PATH: `${path}:${process.env.PATH ?? ''}` } },
  })
}

/** 拉起一个只会应答端口的假远端实例：切换脚本要等端口应声才算就绪。 */
function listenerStartCommand(): string {
  return `( node -e 'require("http").createServer((_, res) => res.end("ok")).listen(${SWITCH_PORT})' </dev/null >/dev/null 2>&1 & )`
}

function switchScript(overrides: { backupTag?: string, startCommand?: string } = {}): string {
  return buildCoreSwitchScript({
    targetTag: 'dsh-new',
    backupTag: overrides.backupTag ?? 'dsh-old',
    runId: 'test',
    profileName: 'remote',
    remotePort: SWITCH_PORT,
    startCommand: overrides.startCommand ?? listenerStartCommand(),
    entryRelativePath: 'lib/bin.js',
    healthPollAttempts: 20,
    healthPollIntervalMs: 500,
  })
}

function completeCopy(deps: string, name: string, version: string): void {
  const dir = join(deps, name)
  mkdirSync(join(dir, 'node_modules/@deepseek-ai/dsh/lib'), { recursive: true })
  writeFileSync(join(dir, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '')
  writeFileSync(join(dir, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ version }))
}

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true })
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
