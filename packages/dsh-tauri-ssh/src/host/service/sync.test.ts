import type { SshExecResult, SshSession } from './transport'
import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_REMOTE_PROFILE } from '../storage/index'
import { MachineId } from '../types/index'
import { layoutNodeBinary } from './bootstrap'
import { buildPreview, classifySpec, installSpecOf, pluginAddCommand, skillExtractCommand, SyncEngine } from './sync'

/** A scripted SSH session: commands dispatched by order or by matcher. */
function fakeSession(respond: (command: string, options?: { stdinData?: Buffer }) => SshExecResult): SshSession & { execSpy: ReturnType<typeof vi.fn>, closed: () => boolean } {
  let open = true
  const execSpy = vi.fn(async (command: string, options?: { stdinData?: Buffer }) => respond(command, options))
  return {
    execSpy,
    exec: execSpy as unknown as SshSession['exec'],
    openTunnel: () => Promise.reject(new Error('not needed')),
    onClosed: () => {},
    close: async () => {
      open = false
    },
    closed: () => !open,
  }
}

const ok = (stdout = ''): SshExecResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string): SshExecResult => ({ code: 1, stdout: '', stderr })

describe('classifySpec', () => {
  it('accepts remotely installable specs', () => {
    expect(classifySpec('github:omdsh-dev/dsh-market').syncable).toBe(true)
    expect(classifySpec('git+https://github.com/a/b.git').syncable).toBe(true)
    expect(classifySpec('git@github.com:a/b.git').syncable).toBe(true)
    expect(classifySpec('^0.3.0').syncable).toBe(true)
    expect(classifySpec('0.16.0').syncable).toBe(true)
    expect(classifySpec(' latest ').syncable).toBe(true)
  })

  it('rejects local-path and URL specs with reasons', () => {
    const local = classifySpec('link:/path/to/plugin')
    expect(local.syncable).toBe(false)
    expect(local.reason).toContain('local-path')
    expect(classifySpec('file:../local').reason).toContain('local-path')
    const url = classifySpec('https://example.com/x.tgz')
    expect(url.syncable).toBe(false)
    expect(url.reason).toContain('URL')
    expect(classifySpec('').reason).toContain('empty')
  })
})

describe('buildPreview', () => {
  it('lists profile dependencies minus core packages, each with a verdict', () => {
    const preview = buildPreview(
      {
        'zz-plugin': 'github:a/b',
        'aa-plugin': '^1.0.0',
        '@deepseek-ai/dsh-client-runtime': '^0.1.0',
        'local-plugin': 'link:../local',
      },
      [],
    )
    expect(preview.plugins.map(plugin => plugin.name)).toEqual(['aa-plugin', 'local-plugin', 'zz-plugin'])
    expect(preview.plugins[2]).toMatchObject({ syncable: true })
    expect(preview.plugins[1]).toMatchObject({ syncable: false, reason: expect.stringContaining('local-path') })
  })

  it('lists skills per root in name order', () => {
    const preview = buildPreview({}, [
      { root: 'dsh', names: ['beta', 'alpha'] },
      { root: 'agents', names: ['zeta'] },
    ])
    expect(preview.skills).toEqual([
      { name: 'alpha', root: 'dsh' },
      { name: 'beta', root: 'dsh' },
      { name: 'zeta', root: 'agents' },
    ])
  })
})

describe('command builders', () => {
  it('runs the layout entry under the layout node, both quoted', () => {
    expect(pluginAddCommand('/home/u/.dsh-desktop/dependencies/dsh/lib/bin.js', 'github:a/b'))
      .toBe(`PATH="$HOME/.dsh-desktop/runtime/bin:$PATH" "$HOME/.dsh-desktop/runtime/bin/node" '/home/u/.dsh-desktop/dependencies/dsh/lib/bin.js' plugin --profile '${DEFAULT_REMOTE_PROFILE}' add 'github:a/b'`)
    expect(pluginAddCommand('/home/u/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', 'pkg@^1.0.0'))
      .toBe(`PATH="$HOME/.dsh-desktop/runtime/bin:$PATH" ${layoutNodeBinary()} '/home/u/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js' plugin --profile '${DEFAULT_REMOTE_PROFILE}' add 'pkg@^1.0.0'`)
  })

  it('installs into the machine profile it is handed, quoted', () => {
    // 隧道只服务这台机器自己的档案：装到别处（历史上的硬编码 web）等于没同步
    expect(pluginAddCommand('/x/bin.js', 'github:a/b', 'work'))
      .toBe(`PATH="$HOME/.dsh-desktop/runtime/bin:$PATH" ${layoutNodeBinary()} '/x/bin.js' plugin --profile 'work' add 'github:a/b'`)
  })

  it('composes the install argument: git specs stand alone, version specs need the name', () => {
    expect(installSpecOf('dsh-market', 'github:omdsh-dev/dsh-market')).toBe('github:omdsh-dev/dsh-market')
    expect(installSpecOf('p', 'git+https://github.com/a/b.git')).toBe('git+https://github.com/a/b.git')
    expect(installSpecOf('p', 'git@github.com:a/b.git')).toBe('git@github.com:a/b.git')
    // 裸范围在远端会被 pnpm 拒（实测 `add '^1.31.1'` 失败、`add 'dshmarket@^1.31.1'` 成功）
    expect(installSpecOf('dshmarket', '^1.31.1')).toBe('dshmarket@^1.31.1')
    expect(installSpecOf('p', ' latest ')).toBe('p@latest')
    expect(installSpecOf('p', '0.16.0')).toBe('p@0.16.0')
  })

  it('extracts the streamed tarball into the remote skill home', () => {
    expect(skillExtractCommand()).toBe(`mkdir -p "$HOME/.dsh/skills" && tar -xf - -C "$HOME/.dsh/skills"`)
  })
})

describe('syncEngine.apply', () => {
  const machine = MachineId('m1')

  it('returns per-item successes when everything lands', async () => {
    const session = fakeSession((command) => {
      // The entry probe is the only command carrying a printf.
      if (command.includes('printf'))
        return ok('/home/u/.dsh-desktop/dependencies/dsh/lib/bin.js\n')
      return ok()
    })
    const packSkills = vi.fn(async () => Buffer.from('TARDATA'))
    const openSession = vi.fn(async () => session)
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [{ root: 'dsh', dir: '/root/skills', names: ['alpha'] }],
      packSkills,
      openSession,
    })
    const result = await sync.apply(machine, [{ name: 'p1', spec: 'github:a/b' }], [{ name: 'alpha', root: 'dsh' }])
    expect(result.items).toEqual([
      { kind: 'plugin', name: 'p1', ok: true },
      { kind: 'skill', name: 'alpha', root: 'dsh', ok: true },
    ])
    // The tarball rode the command's stdin, never the command line.
    const extract = session.execSpy.mock.calls.find(([command]) => command.includes('tar -xf')) as [string, { stdinData?: Buffer }]
    expect(extract[1]?.stdinData?.toString()).toBe('TARDATA')
    expect(extract[0]).not.toContain('TARDATA')
    expect(packSkills).toHaveBeenCalledWith('/root/skills', ['alpha'])
    expect(session.closed()).toBe(true)
  })

  it('reports partial plugin failures per item with the output tail', async () => {
    const session = fakeSession((command) => {
      if (command.includes('printf'))
        return ok('/home/u/.dsh-desktop/dependencies/dsh/lib/bin.js\n')
      return command.includes('bad-pkg') ? fail('ERR_PNPM_NO_MATCH') : ok()
    })
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [],
      packSkills: async () => Buffer.alloc(0),
      openSession: async () => session,
    })
    const result = await sync.apply(
      machine,
      [
        { name: 'good', spec: 'github:a/good' },
        { name: 'bad', spec: 'npm:bad-pkg' },
      ],
      [],
    )
    expect(result.items[0]).toMatchObject({ kind: 'plugin', name: 'good', ok: true })
    expect(result.items[1]).toMatchObject({ kind: 'plugin', name: 'bad', ok: false, error: expect.stringContaining('ERR_PNPM_NO_MATCH') })
    expect(result.items[1]?.error).toContain('exit 1')
  })

  it('fails every plugin item when the remote has no dsh entry', async () => {
    const session = fakeSession(() => ok('\n'))
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [],
      packSkills: async () => Buffer.alloc(0),
      openSession: async () => session,
    })
    const result = await sync.apply(machine, [{ name: 'p', spec: 'github:a/b' }], [])
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ ok: false, error: expect.stringContaining('no dsh entry') })
  })

  it('marks unknown skills and local pack failures without touching the remote', async () => {
    const session = fakeSession(() => ok())
    const packSkills = vi.fn(async () => {
      throw new Error('tar failed: disk full')
    })
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [{ root: 'dsh', dir: '/root/skills', names: ['alpha'] }],
      packSkills,
      openSession: async () => session,
    })
    const result = await sync.apply(machine, [], [
      { name: 'ghost', root: 'dsh' },
      { name: 'alpha', root: 'dsh' },
    ])
    expect(result.items[0]).toMatchObject({ kind: 'skill', name: 'ghost', ok: false, error: expect.stringContaining('not found') })
    expect(result.items[1]).toMatchObject({ kind: 'skill', name: 'alpha', ok: false, error: 'tar failed: disk full' })
    // Nothing reached the remote: every extract carried no stdin payload failure path.
    expect(session.execSpy.mock.calls.some(([command]) => command.includes('tar -xf'))).toBe(false)
  })

  it('reports a remote extract failure on every skill of that root', async () => {
    const session = fakeSession((command) => {
      if (command.includes('tar -xf'))
        return fail('cannot write: read-only file system')
      return ok()
    })
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [{ root: 'dsh', dir: '/root/skills', names: ['alpha', 'beta'] }],
      packSkills: async () => Buffer.from('TAR'),
      openSession: async () => session,
    })
    const result = await sync.apply(machine, [], [
      { name: 'alpha', root: 'dsh' },
      { name: 'beta', root: 'dsh' },
    ])
    expect(result.items).toHaveLength(2)
    for (const item of result.items) {
      expect(item.ok).toBe(false)
      expect(item.error).toContain('read-only file system')
    }
  })

  it('dedupes repeated selections and skips the session for an empty selection', async () => {
    const session = fakeSession(() => ok('/dsh\n'))
    const openSession = vi.fn(async () => session)
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [{ root: 'dsh', dir: '/root/skills', names: ['alpha'] }],
      packSkills: async () => Buffer.alloc(0),
      openSession,
    })
    const empty = await sync.apply(machine, [], [])
    expect(empty.items).toEqual([])
    expect(openSession).not.toHaveBeenCalled()

    const deduped = await sync.apply(
      machine,
      [{ name: 'p', spec: 'github:a/b' }, { name: 'p again', spec: 'github:a/b' }],
      [{ name: 'alpha', root: 'dsh' }, { name: 'alpha', root: 'dsh' }],
    )
    expect(deduped.items).toHaveLength(2)
  })

  it('leads the failure with the cause and keeps the whole output for display', async () => {
    // 真机输出（ops 上 dsh-better-sidebar 的 node-pty 构建失败）：真正的原因在
    // 长长的安装日志中间，末尾反而是 pnpm/dsh 的通用指引——只取末几行会把
    // 操作者引到错误的结论上。
    const stdout = [
      '... pnpm-install: Progress: resolved 584, downloaded 584, added 584, done',
      '... pnpm-install: .../node-pty@1.1.0/node_modules/node-pty install: gyp info it worked if it ends with ok',
      '... pnpm-install: .../node-pty install: make: *** [pty.target.mk:119: Release/obj.target/pty/src/unix/pty.o] Error 127',
      '... pnpm-install: .../node-pty install: gyp ERR! stack Error: `make` failed with exit code: 2',
      '... pnpm-install: [ELIFECYCLE] Command failed with exit code 1.',
      '[ERR_PNPM_PREPARE_PACKAGE] Failed to prepare git-hosted package fetched from "https://codeload.github.com/omdsh-dev/DSH-better-sidebar/tar.gz/1fcf43cc": dsh-better-sidebar@0.19.1 pnpm-install: `pnpm install`',
      'Exit status 1',
      'This error happened while installing a direct dependency of /root/.dsh/profiles/remote',
    ].join('\n')
    const stderr = [
      'dsh: pnpm failed in profile directory /root/.dsh/profiles/remote',
      'dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — add the exact key pnpm printed above',
    ].join('\n')
    const session = fakeSession(command => command.includes('printf') ? ok('/dsh\n') : { code: 1, stdout, stderr })
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [],
      packSkills: async () => Buffer.alloc(0),
      openSession: async () => session,
    })
    const result = await sync.apply(machine, [{ name: 'dsh-better-sidebar', spec: 'github:a/b' }], [], { profileName: 'remote' })
    const item = result.items[0]!
    expect(item.ok).toBe(false)
    // 头一条是真正的原因（缺 make/g++ 的编译失败），且不掺末尾那句会误导人的通用指引
    expect(item.error).toContain('gyp ERR! stack Error: `make` failed with exit code: 2')
    expect(item.error).toContain('Error 127')
    expect(item.error?.startsWith('exit 1: ')).toBe(true)
    expect(item.error).not.toContain('add the exact key pnpm printed above')
    expect(item.error).not.toContain('This error happened while installing')
    // 完整输出随条目返回（供「查看输出」展开）
    expect(item.log).toContain('ERR_PNPM_PREPARE_PACKAGE')
    expect(item.log).toContain('make: ***')
    expect(item.log?.split('\n').length).toBe(10)
  })

  it('caps the carried output and skips it on success', async () => {
    const huge = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n')
    const session = fakeSession(command => command.includes('printf') ? ok('/dsh\n') : { code: 1, stdout: huge, stderr: '' })
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [],
      packSkills: async () => Buffer.alloc(0),
      openSession: async () => session,
    })
    const failed = await sync.apply(machine, [{ name: 'p', spec: 'github:a/b' }], [], { profileName: 'remote' })
    expect(failed.items[0]?.log?.split('\n').length).toBe(60)
    expect(failed.items[0]?.log).toContain('line 199')

    const healthy = fakeSession(() => ok('/dsh\n'))
    const fine = await new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [],
      packSkills: async () => Buffer.alloc(0),
      openSession: async () => healthy,
    }).apply(machine, [{ name: 'p', spec: 'github:a/b' }], [], { profileName: 'remote' })
    expect(fine.items[0]?.log).toBeUndefined()
  })

  it('grants the build keys pnpm asked for and retries the install once', async () => {
    const guidance = `allowBuilds:\n  ${'p@https://example.com/p.tar.gz/abc'}: true\n`
    let installs = 0
    const session = fakeSession((command) => {
      if (command.includes('printf'))
        return ok('/dsh\n')
      if (command.includes('pnpm-workspace.yaml') && command.startsWith('cat '))
        return ok('packages:\n  - .\n')
      if (command.includes('plugin --profile')) {
        installs += 1
        return installs === 1 ? fail(guidance) : ok()
      }
      return ok()
    })
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [],
      packSkills: async () => Buffer.alloc(0),
      openSession: async () => session,
    })
    const result = await sync.apply(machine, [{ name: 'p', spec: 'github:a/b' }], [], { profileName: 'remote' })
    expect(result.items).toEqual([{ kind: 'plugin', name: 'p', ok: true }])
    expect(installs).toBe(2)
    const write = session.execSpy.mock.calls.map(([command]) => command).find(command => command.includes('> "$HOME/.dsh/profiles/remote/pnpm-workspace.yaml"'))
    expect(write).toContain('p@https://example.com/p.tar.gz/abc')
  })

  it('reports the original failure when pnpm names no build key', async () => {
    const session = fakeSession((command) => {
      if (command.includes('printf'))
        return ok('/dsh\n')
      return command.includes('plugin --profile') ? fail('ERR_PNPM_NO_MATCH') : ok()
    })
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [],
      packSkills: async () => Buffer.alloc(0),
      openSession: async () => session,
    })
    const result = await sync.apply(machine, [{ name: 'p', spec: 'github:a/b' }], [], { profileName: 'remote' })
    expect(result.items[0]).toMatchObject({ ok: false })
    expect(result.items[0]?.error).toContain('ERR_PNPM_NO_MATCH')
    expect(session.execSpy.mock.calls.filter(([command]) => command.includes('pnpm-workspace.yaml'))).toHaveLength(0)
  })

  it('installs a version-pinned plugin under its package name', async () => {
    const session = fakeSession((command) => {
      if (command.includes('printf'))
        return ok('/dsh\n')
      return ok()
    })
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [],
      packSkills: async () => Buffer.alloc(0),
      openSession: async () => session,
    })
    await sync.apply(machine, [{ name: 'dshmarket', spec: '^1.31.1' }], [])
    const add = session.execSpy.mock.calls.map(([command]) => command).find(command => command.includes('plugin --profile'))
    expect(add).toContain('add \'dshmarket@^1.31.1\'')
  })

  it('installs plugins into the profile the options name', async () => {
    const session = fakeSession((command) => {
      if (command.includes('printf'))
        return ok('/dsh\n')
      return ok()
    })
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [],
      packSkills: async () => Buffer.alloc(0),
      openSession: async () => session,
    })
    await sync.apply(machine, [{ name: 'p', spec: 'github:a/b' }], [], { profileName: 'work' })
    const add = session.execSpy.mock.calls.map(([command]) => command).find(command => command.includes('plugin --profile'))
    expect(add).toContain('--profile \'work\' add')
  })

  it('announces each item before it runs, 1-based and deduped, skills batched by root', async () => {
    const session = fakeSession((command) => {
      if (command.includes('printf'))
        return ok('/dsh\n')
      return ok()
    })
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [
        { root: 'dsh', dir: '/root/dsh-skills', names: ['alpha', 'beta'] },
        { root: 'agents', dir: '/root/agent-skills', names: ['gamma'] },
      ],
      packSkills: async () => Buffer.alloc(0),
      openSession: async () => session,
    })
    const seen: string[] = []
    await sync.apply(
      machine,
      [{ name: 'p1', spec: 'github:a/b' }, { name: 'p1 dup', spec: 'github:a/b' }, { name: 'p2', spec: '^1.0.0' }],
      [{ name: 'alpha', root: 'dsh' }, { name: 'beta', root: 'dsh' }, { name: 'ghost', root: 'dsh' }, { name: 'gamma', root: 'agents' }],
      { onItem: (position, total, name) => seen.push(`${position}/${total}:${name}`) },
    )
    // 去重后 2 插件 + 4 skill；ghost 在本地校验出局（不公告但照样结算），
    // 每个 root 的 skill 共用一份 tar，故只公告批首那条。
    expect(seen).toEqual(['1/6:p1', '2/6:p2', '4/6:alpha', '6/6:gamma'])
  })
})
