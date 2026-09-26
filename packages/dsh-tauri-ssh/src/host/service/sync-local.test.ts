import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { profileAllowlistReader, profileDependenciesReader } from './sync-local'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One scratch harness home with the profile files a real install leaves. */
function scratchHome(files: { manifest?: string, workspace?: string }): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-sync-local-'))
  roots.push(home)
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  if (files.manifest !== undefined)
    writeFileSync(join(profile, 'package.json'), files.manifest)
  if (files.workspace !== undefined)
    writeFileSync(join(profile, 'pnpm-workspace.yaml'), files.workspace)
  return home
}

describe('profileAllowlistReader', () => {
  it('reads both allowlist sections from the profile workspace file', () => {
    const home = scratchHome({
      workspace: [
        'packages:',
        '  - .',
        'allowBuilds:',
        '  node-pty: true',
        'onlyBuiltDependencies:',
        '  - dsh-better-sidebar',
        '',
      ].join('\n'),
    })
    expect(profileAllowlistReader(home, 'web')()).toEqual({
      allowBuilds: { 'node-pty': true },
      onlyBuiltDependencies: ['dsh-better-sidebar'],
    })
  })

  it('reads a missing file as empty instead of raising', () => {
    expect(profileAllowlistReader(scratchHome({}), 'web')()).toEqual({ allowBuilds: {}, onlyBuiltDependencies: [] })
  })

  it('tolerates a CRLF document written on Windows', () => {
    const home = scratchHome({ workspace: 'allowBuilds:\r\n  node-pty: true\r\n' })
    expect(profileAllowlistReader(home, 'web')().allowBuilds).toEqual({ 'node-pty': true })
  })
})

describe('profileDependenciesReader', () => {
  it('reads the profile manifest and reads a broken one as empty', () => {
    const good = scratchHome({ manifest: JSON.stringify({ dependencies: { 'a': '^1.0.0', '@scope/b': 'github:x/y' } }) })
    expect(profileDependenciesReader(good)()).toEqual({ 'a': '^1.0.0', '@scope/b': 'github:x/y' })
    expect(profileDependenciesReader(scratchHome({ manifest: '{oops' }))()).toEqual({})
  })
})
