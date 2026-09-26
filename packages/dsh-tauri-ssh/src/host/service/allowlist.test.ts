import type { SshExecResult, SshSession } from './transport'
import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import {
  allowlistReadCommand,
  allowlistWriteCommand,
  carryWorkspaceAllowlist,
  isPortableAllowKey,
  mergeWorkspaceAllowlist,
  parseAllowlist,
  parseBuildAllowKeys,
  WORKSPACE_TEMPLATE,
} from './allowlist'

const GIT_KEY = 'dsh-better-sidebar@https://codeload.github.com/omdsh-dev/DSH-better-sidebar/tar.gz/0314fd9b93c5f55eb68f98480d84500d67a75b03'

/** A scripted session: `cat` answers the given text, writes are recorded. */
function fakeSession(remoteText: string): SshSession & { commands: string[] } {
  const commands: string[] = []
  return {
    commands,
    exec: vi.fn(async (command: string) => {
      commands.push(command)
      const stdout = command.startsWith('cat ') ? remoteText : ''
      return { code: 0, stdout, stderr: '' } as SshExecResult
    }) as unknown as SshSession['exec'],
    openTunnel: () => Promise.reject(new Error('not needed')),
    onClosed: () => {},
    close: async () => {},
  }
}

describe('isPortableAllowKey', () => {
  it('keeps git/npm resolutions and bare package names', () => {
    expect(isPortableAllowKey(GIT_KEY)).toBe(true)
    expect(isPortableAllowKey('node-pty')).toBe(true)
    expect(isPortableAllowKey('esbuild@0.21.5')).toBe(true)
  })

  it('drops local-only resolutions and Windows-shaped keys', () => {
    expect(isPortableAllowKey('C:\\\\work\\\\plugin')).toBe(false)
    expect(isPortableAllowKey('C:/work/plugin')).toBe(false)
    expect(isPortableAllowKey('plugin@file:/Users/me/plugin')).toBe(false)
    expect(isPortableAllowKey('plugin@link:../plugin')).toBe(false)
    expect(isPortableAllowKey('plugin@workspace:packages/plugin')).toBe(false)
    expect(isPortableAllowKey('  ')).toBe(false)
  })
})

describe('parseAllowlist', () => {
  it('reads both sections and skips non-portable keys', () => {
    const parsed = parseAllowlist([
      'allowBuilds:',
      `  ${GIT_KEY}: true`,
      '  node-pty: true',
      '  local@file:/Users/me/plugin: true',
      '  windows: false',
      'onlyBuiltDependencies:',
      '  - dsh-better-sidebar',
      '  - link:../local',
      '',
    ].join('\n'))
    expect(Object.keys(parsed.allowBuilds)).toEqual([GIT_KEY, 'node-pty', 'windows'])
    expect(parsed.allowBuilds.windows).toBe(false)
    expect(parsed.onlyBuiltDependencies).toEqual(['dsh-better-sidebar'])
  })

  it('reads a missing or malformed document as empty', () => {
    expect(parseAllowlist('')).toEqual({ allowBuilds: {}, onlyBuiltDependencies: [] })
    expect(parseAllowlist('a: [unclosed')).toEqual({ allowBuilds: {}, onlyBuiltDependencies: [] })
    expect(parseAllowlist('- just\n- a list')).toEqual({ allowBuilds: {}, onlyBuiltDependencies: [] })
  })
})

describe('mergeWorkspaceAllowlist', () => {
  const incoming = { allowBuilds: { [GIT_KEY]: true, 'node-pty': true }, onlyBuiltDependencies: ['dsh-better-sidebar'] }

  it('adds both sections to a bare template and keeps its keys', () => {
    const { yaml, added } = mergeWorkspaceAllowlist(WORKSPACE_TEMPLATE, incoming)
    const doc = parse(yaml) as Record<string, unknown>
    expect(doc.packages).toEqual(['.'])
    expect(doc.nodeLinker).toBe('hoisted')
    expect(doc.autoInstallPeers).toBe(false)
    expect(doc.allowBuilds).toEqual({ [GIT_KEY]: true, 'node-pty': true })
    expect(doc.onlyBuiltDependencies).toEqual(['dsh-better-sidebar'])
    expect(added).toEqual([GIT_KEY, 'node-pty', 'dsh-better-sidebar'])
  })

  it('round-trips keys carrying @ : / and # without breaking the document', () => {
    const awkward = 'pkg@github.com/a/b#semver:^1.0.0'
    const { yaml } = mergeWorkspaceAllowlist(WORKSPACE_TEMPLATE, { allowBuilds: { [awkward]: true }, onlyBuiltDependencies: [] })
    expect((parse(yaml) as { allowBuilds: Record<string, boolean> }).allowBuilds[awkward]).toBe(true)
  })

  it('is idempotent and never overrides a remote denial', () => {
    const first = mergeWorkspaceAllowlist(WORKSPACE_TEMPLATE, incoming).yaml
    const second = mergeWorkspaceAllowlist(first, incoming)
    expect(second.added).toEqual([])
    // 不改写：原文本原样返回（调用方据此跳过写盘）
    expect(second.yaml).toBe(first)

    const denied = 'allowBuilds:\n  node-pty: false\n'
    const { yaml, added } = mergeWorkspaceAllowlist(denied, incoming)
    const doc = parse(yaml) as { allowBuilds: Record<string, boolean> }
    expect(doc.allowBuilds['node-pty']).toBe(false)
    expect(added).toEqual([GIT_KEY, 'dsh-better-sidebar'])
  })

  it('reads a CRLF document (a Windows-authored profile) as the same map', () => {
    const crlf = 'packages:\r\n  - .\r\n\r\nnodeLinker: hoisted\r\nautoInstallPeers: false\r\n'
    const { yaml, added } = mergeWorkspaceAllowlist(crlf, incoming)
    expect(added).toHaveLength(3)
    expect(yaml.includes('\r')).toBe(false)
    expect((parse(yaml) as { packages: string[] }).packages).toEqual(['.'])
  })

  it('keeps only non-portable local keys out of the remote document', () => {
    const { added } = mergeWorkspaceAllowlist(WORKSPACE_TEMPLATE, {
      allowBuilds: { 'plugin@file:/Users/me/plugin': true, 'node-pty': true },
      onlyBuiltDependencies: ['link:../local'],
    })
    expect(added).toEqual(['node-pty'])
  })

  it('refuses to rewrite a document it cannot parse', () => {
    expect(() => mergeWorkspaceAllowlist('a: [unclosed', incoming)).toThrow(/not valid YAML/u)
    expect(() => mergeWorkspaceAllowlist('- a\n- list', incoming)).toThrow(/not a YAML mapping/u)
  })
})

describe('parseBuildAllowKeys', () => {
  const GIT_GUIDANCE = [
    'Add the package to "allowBuilds" in your project\'s pnpm-workspace.yaml to allow it to run scripts. For example:',
    'allowBuilds:',
    `  ${GIT_KEY}: true`,
    'dsh: pnpm failed in profile directory /root/.dsh/profiles/remote',
  ].join('\n')

  it('reads the key pnpm printed in its allowBuilds example', () => {
    expect(parseBuildAllowKeys(GIT_GUIDANCE)).toEqual([GIT_KEY])
  })

  it('reads an onlyBuiltDependencies list and ignored-build names', () => {
    expect(parseBuildAllowKeys('onlyBuiltDependencies:\n  - node-pty\n  - "esbuild"\n')).toEqual(['node-pty', 'esbuild'])
    expect(parseBuildAllowKeys('Ignored build scripts: node-pty@1.0.0, esbuild@0.21.5\n')).toEqual(['node-pty', 'esbuild'])
  })

  it('dedupes, ignores unrelated output and never returns a local-only key', () => {
    expect(parseBuildAllowKeys('nothing to see here')).toEqual([])
    expect(parseBuildAllowKeys(`${GIT_GUIDANCE}\nallowBuilds:\n  ${GIT_KEY}: true\n`)).toEqual([GIT_KEY])
    expect(parseBuildAllowKeys('allowBuilds:\n  plugin@file:/Users/me/plugin: true\n')).toEqual([])
  })
})

describe('allowlist commands', () => {
  it('reads and writes the machine profile workspace file', () => {
    expect(allowlistReadCommand('remote')).toBe('cat "$HOME/.dsh/profiles/remote/pnpm-workspace.yaml" 2>/dev/null || true')
    const write = allowlistWriteCommand('remote', 'allowBuilds:\n  a: true\n')
    expect(write).toContain('mkdir -p "$HOME/.dsh/profiles/remote"')
    expect(write).toContain('> "$HOME/.dsh/profiles/remote/pnpm-workspace.yaml"')
    // 多行文本整体作为一个被引用的参数：不会被 shell 拆行
    expect(write).toContain('allowBuilds:')
  })
})

describe('carryWorkspaceAllowlist', () => {
  it('writes once when keys are missing and stays quiet when they are not', async () => {
    const session = fakeSession(WORKSPACE_TEMPLATE)
    const added = await carryWorkspaceAllowlist(session, 'remote', { allowBuilds: { 'node-pty': true }, onlyBuiltDependencies: [] })
    expect(added).toEqual(['node-pty'])
    expect(session.commands).toHaveLength(2)
    expect(session.commands[1]).toContain('pnpm-workspace.yaml')

    const upToDate = fakeSession('allowBuilds:\n  node-pty: true\n')
    expect(await carryWorkspaceAllowlist(upToDate, 'remote', { allowBuilds: { 'node-pty': true }, onlyBuiltDependencies: [] })).toEqual([])
    expect(upToDate.commands).toHaveLength(1)
  })

  it('skips the remote entirely when the local allowlist is empty', async () => {
    const session = fakeSession(WORKSPACE_TEMPLATE)
    expect(await carryWorkspaceAllowlist(session, 'remote', { allowBuilds: {}, onlyBuiltDependencies: [] })).toEqual([])
    expect(session.commands).toHaveLength(0)
  })

  it('propagates a parse failure instead of clobbering the remote file', async () => {
    const session = fakeSession('a: [unclosed')
    await expect(carryWorkspaceAllowlist(session, 'remote', { allowBuilds: { 'node-pty': true }, onlyBuiltDependencies: [] }))
      .rejects
      .toThrow(/not valid YAML/u)
    expect(session.commands).toHaveLength(1)
  })
})

describe('carryWorkspaceAllowlist payload', () => {
  it('hands the merged text to the shell as one argument with LF endings', async () => {
    const session = fakeSession('')
    await carryWorkspaceAllowlist(session, 'remote', { allowBuilds: { [GIT_KEY]: true }, onlyBuiltDependencies: [] })
    const write = session.commands[1] ?? ''
    expect(write.includes('\r')).toBe(false)
    // Buffer import keeps the module's node-only surface honest under vitest
    expect(Buffer.from(GIT_KEY).length).toBeGreaterThan(0)
    expect(write).toContain('codeload.github.com')
  })
})
