/**
 * The `~/.ssh` credential layer: config parsing, OpenSSH matching semantics,
 * Include expansion, and the resolver. All file access is sandboxed into a
 * scratch ssh directory per test — the developer's real `~/.ssh` is never
 * read.
 */

import type { MachineProfile } from '../types/index'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MachineId } from '../types/index'
import {
  DEFAULT_IDENTITY_FILES,
  discoverableHosts,
  expandIncludePath,
  expandTokenPath,
  hostPatternMatches,
  loadSshConfigBlocks,
  lookupSshConfig,
  parseSshConfig,
  SshConfigResolver,
} from './ssh-config'

const FIXTURES = join(import.meta.dirname, 'fixtures')

let home: string
let sshDir: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ssh-home-'))
  sshDir = join(home, '.ssh')
  await mkdir(sshDir, { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** A machine profile that resolves against the scratch ssh dir. */
function profile(overrides: Partial<MachineProfile> = {}): MachineProfile {
  return {
    id: MachineId('m1'),
    name: 'alpha',
    host: '10.0.0.1',
    port: 22,
    user: 'root',
    remotePort: 3080,
    ...overrides,
  }
}

/** Copy every fixture identity file into the scratch ssh dir. */
async function installFixtures(): Promise<void> {
  await copyFile(join(FIXTURES, 'id_ed25519'), join(sshDir, 'id_ed25519'))
  await copyFile(join(FIXTURES, 'id_ed25519.pub'), join(sshDir, 'id_ed25519.pub'))
  await copyFile(join(FIXTURES, 'id_ed25519_enc'), join(sshDir, 'id_ed25519_enc'))
  await copyFile(join(FIXTURES, 'garbage.txt'), join(sshDir, 'garbage.txt'))
}

describe('parseSshConfig', () => {
  it('parses Host blocks, case-insensitive keywords, and both separators', () => {
    const blocks = parseSshConfig([
      'Host webserver',
      '  HostName 10.0.0.9',
      '  User = deploy',
      '  PORT 2222',
      '',
      'Host *',
      '\tIdentityFile ~/.ssh/one',
      '# a comment',
      '  IdentityFile=~/.ssh/two',
    ].join('\n'))
    expect(blocks).toEqual([
      { patterns: ['webserver'], values: { hostname: ['10.0.0.9'], user: ['deploy'], port: ['2222'] } },
      { patterns: ['*'], values: { identityfile: ['~/.ssh/one', '~/.ssh/two'] } },
    ])
  })

  it('drops lines before the first Host block and skips Match', () => {
    const blocks = parseSshConfig([
      'User nobody',
      'Match host foo',
      '  User someone-else',
      'Host box',
    ].join('\n'))
    expect(blocks).toEqual([{ patterns: ['box'], values: {} }])
  })

  it('keeps multi-word Host pattern lists', () => {
    const blocks = parseSshConfig('Host a b c\n  User u\n')
    expect(blocks[0]?.patterns).toEqual(['a', 'b', 'c'])
  })

  it('skips empty keys and values', () => {
    const blocks = parseSshConfig(['= x', 'Host', '  User', 'Host box', '  User u'].join('\n'))
    expect(blocks).toEqual([{ patterns: ['box'], values: { user: ['u'] } }])
  })
})

describe('hostPatternMatches', () => {
  it('matches literals, case-insensitively', () => {
    expect(hostPatternMatches('WebServer', 'webserver')).toBe(true)
    expect(hostPatternMatches('webserver', 'other')).toBe(false)
  })

  it('matches * and ? globs', () => {
    expect(hostPatternMatches('*.example.com', 'box.example.com')).toBe(true)
    expect(hostPatternMatches('*.example.com', 'box.example.org')).toBe(false)
    expect(hostPatternMatches('box?', 'box1')).toBe(true)
    expect(hostPatternMatches('box?', 'box')).toBe(false)
  })

  it('decides on the first matching comma alternative, negation included', () => {
    expect(hostPatternMatches('!foo,bar', 'foo')).toBe(false)
    expect(hostPatternMatches('!foo,bar', 'bar')).toBe(true)
    expect(hostPatternMatches('!foo,bar', 'baz')).toBe(false)
  })

  it('backtracks a greedy star', () => {
    expect(hostPatternMatches('a*c', 'abc')).toBe(true)
    expect(hostPatternMatches('a*b*c', 'aXXbYYc')).toBe(true)
    expect(hostPatternMatches('a*c', 'abxd')).toBe(false)
  })
})

describe('discoverableHosts', () => {
  it('keeps literal aliases, drops wildcards, negations, and comma alternations', () => {
    const blocks = parseSshConfig([
      'Host dev ci',
      'Host github.com',
      'Host *.example.com',
      'Host !banned',
      'Host a,b',
      'Host *',
    ].join('\n'))
    expect(discoverableHosts(blocks)).toEqual(['ci', 'dev', 'github.com'])
  })

  it('deduplicates aliases across blocks and sorts them', () => {
    const blocks = parseSshConfig('Host b\nHost a\nHost b\n')
    expect(discoverableHosts(blocks)).toEqual(['a', 'b'])
  })

  it('lists nothing for no blocks or no literal patterns', () => {
    expect(discoverableHosts([])).toEqual([])
    expect(discoverableHosts(parseSshConfig('Host *\nHost !x\n'))).toEqual([])
  })
})

describe('expandTokenPath', () => {
  it('expands ~, ~/, bare relative paths, and the %d/%h/%r tokens', () => {
    expect(expandTokenPath('~', home, 'h', 'r')).toBe(home)
    expect(expandTokenPath('~/keys/id', home, 'h', 'r')).toBe(join(home, 'keys/id'))
    expect(expandTokenPath('keys/id', home, 'h', 'r')).toBe(join(home, 'keys/id'))
    expect(expandTokenPath('/abs/path', home, 'h', 'r')).toBe('/abs/path')
    expect(expandTokenPath('%d/id_%h_%r', home, 'box', 'ops')).toBe(join(home, `id_box_ops`))
  })
})

describe('expandIncludePath', () => {
  it('keeps literal paths and anchors bare relative ones under the ssh dir', () => {
    expect(expandIncludePath('~/.ssh/extra', sshDir, home, '', '')).toEqual([join(home, '.ssh/extra')])
    expect(expandIncludePath('/etc/ssh/extra', sshDir, home, '', '')).toEqual(['/etc/ssh/extra'])
    expect(expandIncludePath('conf.d/a', sshDir, home, '', '')).toEqual([join(sshDir, 'conf.d/a')])
  })

  it('expands a basename glob into sorted matches, dropping nothing existing', async () => {
    await mkdir(join(sshDir, 'conf.d'), { recursive: true })
    await writeFile(join(sshDir, 'conf.d/b.conf'), 'Host b\n')
    await writeFile(join(sshDir, 'conf.d/a.conf'), 'Host a\n')
    await writeFile(join(sshDir, 'conf.d/other.txt'), '')
    expect(expandIncludePath('conf.d/*.conf', sshDir, home, '', '')).toEqual([
      join(sshDir, 'conf.d/a.conf'),
      join(sshDir, 'conf.d/b.conf'),
    ])
  })

  it('reads an unreadable directory as no targets', () => {
    expect(expandIncludePath('missing/*.conf', sshDir, home, '', '')).toEqual([])
  })

  it('anchors separator-less paths under the ssh dir, glob or literal', async () => {
    await writeFile(join(sshDir, 'root.conf'), 'Host r\n')
    expect(expandIncludePath('plain', sshDir, home, '', '')).toEqual([join(sshDir, 'plain')])
    expect(expandIncludePath('*.conf', sshDir, home, '', '')).toEqual([join(sshDir, 'root.conf')])
  })
})

describe('lookupSshConfig', () => {
  it('applies first-match-wins per parameter and accumulates IdentityFile across matching blocks', () => {
    const blocks = parseSshConfig([
      'Host 10.0.0.1',
      '  HostName 10.0.0.1',
      '  User first',
      '  IdentityFile ~/.ssh/one',
      'Host 10.0.0.*',
      '  User second',
      '  Port 2222',
      '  IdentityFile ~/.ssh/two',
    ].join('\n'))
    const settings = lookupSshConfig(blocks, '10.0.0.1')
    expect(settings).toEqual({
      hostName: '10.0.0.1',
      user: 'first',
      port: 2222,
      identityFiles: ['~/.ssh/one', '~/.ssh/two'],
      proxyJump: [],
    })
  })

  it('resolves ProxyJump chains with overrides, none, and first-wins', () => {
    const blocks = parseSshConfig([
      'Host ops',
      '  ProxyJump root@dev:2222,none',
      'Host *',
      '  ProxyJump bastion',
    ].join('\n'))
    // 首个命中块先取值：ops 自己的 ProxyJump 胜出；none 过滤、逗号成链
    expect(lookupSshConfig(blocks, 'ops').proxyJump).toEqual(['root@dev:2222'])
    // 无块命中的回落到 Host *
    expect(lookupSshConfig(blocks, 'other').proxyJump).toEqual(['bastion'])
  })

  it('skips negated blocks and non-matching wildcards', () => {
    const blocks = parseSshConfig([
      'Host !10.0.0.1 *.example.com',
      '  User special',
      '  IdentityFile ~/.ssh/special',
      'Host *',
      '  IdentityFile ~/.ssh/generic',
    ].join('\n'))
    const settings = lookupSshConfig(blocks, 'box.example.com')
    expect(settings.user).toBe('special')
    expect(settings.identityFiles).toEqual(['~/.ssh/special', '~/.ssh/generic'])
    const excluded = lookupSshConfig(blocks, '10.0.0.1')
    expect(excluded.user).toBeUndefined()
    expect(excluded.identityFiles).toEqual(['~/.ssh/generic'])
  })

  it('returns only the defaults shape for no matches', () => {
    expect(lookupSshConfig([], 'anything')).toEqual({ identityFiles: [], proxyJump: [] })
  })
})

describe('loadSshConfigBlocks', () => {
  it('reads nothing for a missing config', async () => {
    expect(await loadSshConfigBlocks(sshDir, home)).toEqual([])
  })

  it('loads the main config and recursive includes with relative and glob paths', async () => {
    await mkdir(join(sshDir, 'conf.d'), { recursive: true })
    await writeFile(join(sshDir, 'conf.d/base.conf'), 'Host base\n  User b\n')
    await writeFile(join(sshDir, 'conf.d/extra.conf'), 'Include conf.d/base.conf\nHost extra\n  User e\n')
    await writeFile(join(sshDir, 'config'), [
      'Host main\n  User m\n',
      'Include conf.d/*.conf\n',
      'Host after\n  User a\n',
    ].join(''))
    const blocks = await loadSshConfigBlocks(sshDir, home)
    const names = blocks.map(block => block.patterns[0])
    expect(names).toEqual(['main', 'base', 'extra', 'after'])
    expect(blocks[1]?.values.user).toEqual(['b'])
  })

  it('skips missing includes silently and caps the include depth', async () => {
    await mkdir(join(sshDir, 'chain'), { recursive: true })
    for (let i = 0; i < 12; i++) {
      const next = i + 1
      await writeFile(join(sshDir, 'chain', `c${i}.conf`), `Include chain/c${next}.conf\nHost c${i}\n`)
    }
    await writeFile(join(sshDir, 'chain', 'c12.conf'), 'Host c12\n')
    await writeFile(join(sshDir, 'config'), 'Include chain/c0.conf\nInclude /missing/nowhere\n')
    const blocks = await loadSshConfigBlocks(sshDir, home)
    expect(blocks.length).toBeLessThan(12)
  })

  it('never revisits the same file (cycle safety)', async () => {
    await mkdir(join(sshDir, 'loop'), { recursive: true })
    await writeFile(join(sshDir, 'loop/a.conf'), 'Include loop/b.conf\nHost a\n')
    await writeFile(join(sshDir, 'loop/b.conf'), 'Include loop/a.conf\nHost b\n')
    await writeFile(join(sshDir, 'config'), 'Include loop/a.conf\n')
    const blocks = await loadSshConfigBlocks(sshDir, home)
    expect(blocks.map(block => block.patterns[0])).toEqual(['b', 'a'])
  })
})

describe('sshConfigResolver', () => {
  it('uses the profile fields and default identity files when no config exists', async () => {
    await installFixtures()
    const resolver = new SshConfigResolver(sshDir, home, 'fallback-user')
    const auth = await resolver.resolve(profile())
    expect(auth).toMatchObject({ host: '10.0.0.1', port: 22, username: 'root' })
    // Defaults are id_ed25519/id_ecdsa/id_rsa; the missing ones are skipped.
    expect(auth.keys).toEqual([{ privateKey: await readFile(join(sshDir, 'id_ed25519'), 'utf8') }])
    expect(DEFAULT_IDENTITY_FILES).toEqual(['id_ed25519', 'id_ecdsa', 'id_rsa'])
  })

  it('resolves a config alias: HostName/User/Port/IdentityFile override the profile', async () => {
    await installFixtures()
    await writeFile(join(sshDir, 'config'), [
      'Host webserver',
      '  HostName 10.0.0.9',
      '  User deploy',
      '  Port 2222',
      '  IdentityFile %d/.ssh/id_ed25519',
    ].join('\n'))
    const resolver = new SshConfigResolver(sshDir, home, 'fallback')
    const auth = await resolver.resolve(profile({ host: 'webserver', user: '' }))
    expect(auth).toMatchObject({ host: '10.0.0.9', port: 2222, username: 'deploy' })
    expect(auth.keys).toEqual([{ privateKey: await readFile(join(sshDir, 'id_ed25519'), 'utf8') }])
  })

  it('hands every configured IdentityFile to ssh2 as-is (it validates and skips)', async () => {
    await installFixtures()
    await writeFile(join(sshDir, 'config'), [
      'Host box',
      '  IdentityFile .ssh/id_ed25519.pub',
      '  IdentityFile .ssh/id_ed25519_enc',
      '  IdentityFile .ssh/garbage.txt',
      '  IdentityFile %h-keys/id',
    ].join('\n'))
    const resolver = new SshConfigResolver(sshDir, home, 'os-user')
    const auth = await resolver.resolve(profile({ host: 'box', user: '' }))
    expect(auth.keys).toEqual([
      { privateKey: await readFile(join(sshDir, 'id_ed25519.pub'), 'utf8') },
      { privateKey: await readFile(join(sshDir, 'id_ed25519_enc'), 'utf8') },
      { privateKey: await readFile(join(sshDir, 'garbage.txt'), 'utf8') },
    ])
  })

  it('prefers the profile user over the config user over the default user', async () => {
    await writeFile(join(sshDir, 'config'), 'Host box\n  User config-user\n')
    const resolver = new SshConfigResolver(sshDir, home, 'os-user')
    expect((await resolver.resolve(profile({ host: 'box', user: 'profile-user' }))).username).toBe('profile-user')
    expect((await resolver.resolve(profile({ host: 'box', user: '' }))).username).toBe('config-user')
    expect((await resolver.resolve(profile({ host: 'no-match', user: '' }))).username).toBe('os-user')
  })

  it('attaches the stored password and passphrase, and skips unreadable keys', async () => {
    await installFixtures()
    await writeFile(join(sshDir, 'config'), 'Host box\n  IdentityFile %h-keys/id\n  IdentityFile .ssh/id_ed25519\n')
    const resolver = new SshConfigResolver(sshDir, home, 'os-user')
    const auth = await resolver.resolve(profile({
      host: 'box',
      user: '',
      password: 'pw',
      passphrase: 'phrase',
    }))
    expect(auth.password).toBe('pw')
    expect(auth.keys).toEqual([{ privateKey: await readFile(join(sshDir, 'id_ed25519'), 'utf8'), passphrase: 'phrase' }])
  })

  it('re-reads keys on every resolve (fresh ~/.ssh)', async () => {
    await installFixtures()
    const resolver = new SshConfigResolver(sshDir, home)
    const first = await resolver.resolve(profile())
    const rotated = '-----BEGIN OPENSSH PRIVATE KEY-----\nrotated\n'
    await writeFile(join(sshDir, 'id_ed25519'), rotated)
    const second = await resolver.resolve(profile())
    expect(first.keys[0]?.privateKey).not.toBe(rotated)
    expect(second.keys[0]?.privateKey).toBe(rotated)
  })

  it('falls back to an empty user when nothing names one', async () => {
    const previous = process.env.USER
    try {
      delete process.env.USER
      const resolver = new SshConfigResolver(sshDir, home)
      const auth = await resolver.resolve(profile({ user: '' }))
      expect(auth.username).toBe('')
    }
    finally {
      if (previous !== undefined)
        process.env.USER = previous
    }
  })
})
