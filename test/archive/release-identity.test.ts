import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import * as releaseIdentityModule from '../../scripts/release-identity.mjs'

interface SemverIdentity {
  version: string
  prerelease: string | null
  build: string | null
}

interface ReleaseIdentity {
  version: string
  semver: SemverIdentity
}

interface ReleaseIdentityModule {
  parseSemver: (version: unknown) => SemverIdentity
  readCargoPackageVersion: (content: unknown) => string
  readReleaseIdentity: (repo?: string) => ReleaseIdentity
  deriveReleaseMetadata: (input: {
    eventName: string
    pushTag?: string
    sourceRef: string
    identity: ReleaseIdentity
  }) => {
    tag: string
    prerelease: boolean
    should_release: boolean
    source_ref: string
  }
}

const releaseIdentityScript = fileURLToPath(new URL('../scripts/release-identity.mjs', import.meta.url))
const releaseIdentity = releaseIdentityModule as ReleaseIdentityModule

const sourceSha = '1'.repeat(40)
const temporaryRepos: string[] = []

function writeReleaseFiles(versions: {
  packageJson: string
  cargoToml: string
  tauriConfig: string
}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'release-identity-'))
  temporaryRepos.push(repo)
  mkdirSync(path.join(repo, 'src-tauri'))
  writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'desktop', version: versions.packageJson }),
  )
  writeFileSync(
    path.join(repo, 'src-tauri', 'Cargo.toml'),
    `[workspace.package]\nversion = "9.9.9"\n\n[package]\nname = "desktop"\nversion = "${versions.cargoToml}"\n`,
  )
  writeFileSync(
    path.join(repo, 'src-tauri', 'tauri.conf.json'),
    JSON.stringify({ productName: 'Desktop', version: versions.tauriConfig }),
  )
  return repo
}

function matchingIdentity(version: string): ReleaseIdentity {
  return {
    version,
    semver: releaseIdentity.parseSemver(version),
  }
}

afterEach(() => {
  for (const repo of temporaryRepos.splice(0))
    rmSync(repo, { recursive: true, force: true })
})

describe('release version identity', () => {
  it.each([
    ['1.2.3', null, null],
    ['1.2.3-rc.1', 'rc.1', null],
    ['1.2.3+build-alpha.7', null, 'build-alpha.7'],
    ['1.2.3-rc.1+build.7', 'rc.1', 'build.7'],
    ['9007199254740993.9007199254740995.9007199254740997', null, null],
  ])('parses strict SemVer %s', (version, prerelease, build) => {
    expect(releaseIdentity.parseSemver(version)).toEqual({ version, prerelease, build })
  })

  it.each(['v1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2', '1.2.3-01', '1.2.3+'])(
    'rejects non-SemVer version %s',
    (version) => {
      expect(() => releaseIdentity.parseSemver(version)).toThrow(/^RELEASE_IDENTITY:/)
    },
  )

  it('reads only the Cargo [package] version', () => {
    const cargo = `
[workspace.package]
version = "8.0.0"

[dependencies]
version = "7.0.0"

[package] # release identity
name = "desktop"
version = '1.2.3-rc.1' # current release

[package.metadata.release]
version = "6.0.0"
`
    expect(releaseIdentity.readCargoPackageVersion(cargo)).toBe('1.2.3-rc.1')
  })

  it('reads one coherent identity from all release files', () => {
    const repo = writeReleaseFiles({
      packageJson: '1.2.3+build.4',
      cargoToml: '1.2.3+build.4',
      tauriConfig: '1.2.3+build.4',
    })
    expect(releaseIdentity.readReleaseIdentity(repo)).toMatchObject({
      version: '1.2.3+build.4',
      semver: { prerelease: null, build: 'build.4' },
    })
  })

  it.each([
    { packageJson: '1.2.4', cargoToml: '1.2.3', tauriConfig: '1.2.3' },
    { packageJson: '1.2.3', cargoToml: '1.2.4', tauriConfig: '1.2.3' },
    { packageJson: '1.2.3', cargoToml: '1.2.3', tauriConfig: '1.2.4' },
  ])('rejects mismatched release files with every value named', (versions) => {
    const repo = writeReleaseFiles(versions)
    expect(() => releaseIdentity.readReleaseIdentity(repo)).toThrow(
      /release versions do not match: package\.json=1\.2\.[34], src-tauri\/Cargo\.toml=1\.2\.[34], src-tauri\/tauri\.conf\.json=1\.2\.[34]/,
    )
  })
})

describe('release event metadata', () => {
  it.each([
    ['push', 'v1.2.3', 'v1.2.3', true],
    ['pull_request', '', 'v1.2.3', true],
    ['workflow_dispatch', '', '', false],
  ])('derives %s metadata from the checked-out source', (eventName, pushTag, tag, shouldRelease) => {
    expect(releaseIdentity.deriveReleaseMetadata({
      eventName,
      pushTag,
      sourceRef: sourceSha.toUpperCase(),
      identity: matchingIdentity('1.2.3'),
    })).toEqual({
      tag,
      prerelease: false,
      should_release: shouldRelease,
      source_ref: sourceSha,
    })
  })

  it('uses parsed prerelease identity rather than a hyphen in build metadata', () => {
    const prerelease = releaseIdentity.deriveReleaseMetadata({
      eventName: 'pull_request',
      sourceRef: sourceSha,
      identity: matchingIdentity('1.2.3-rc.1+build-alpha'),
    })
    const stable = releaseIdentity.deriveReleaseMetadata({
      eventName: 'pull_request',
      sourceRef: sourceSha,
      identity: matchingIdentity('1.2.3+build-alpha'),
    })
    expect(prerelease.prerelease).toBe(true)
    expect(stable.prerelease).toBe(false)
  })

  it.each(['v1.2.4', '1.2.3'])(
    'rejects pushed tag %s when it differs from the checked-out version tag',
    (pushTag) => {
      expect(() => releaseIdentity.deriveReleaseMetadata({
        eventName: 'push',
        pushTag,
        sourceRef: sourceSha,
        identity: matchingIdentity('1.2.3'),
      })).toThrow(/does not match checked-out version tag v1\.2\.3/)
    },
  )

  it.each(['1'.repeat(39), 'g'.repeat(40)])('rejects invalid source commit %s', (sourceRef) => {
    expect(() => releaseIdentity.deriveReleaseMetadata({
      eventName: 'pull_request',
      sourceRef,
      identity: matchingIdentity('1.2.3'),
    })).toThrow(/source_ref must be a full 40-character commit SHA/)
  })

  it('writes workflow outputs from the checked-out commit', () => {
    const repo = writeReleaseFiles({
      packageJson: '1.2.3',
      cargoToml: '1.2.3',
      tauriConfig: '1.2.3',
    })
    const outputPath = path.join(repo, 'github-output.txt')
    execFileSync('git', ['init', '--quiet'], { cwd: repo })
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo })
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Release Test',
        '-c',
        'user.email=release@example.test',
        'commit',
        '--quiet',
        '-m',
        'release',
      ],
      { cwd: repo },
    )
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim()

    execFileSync(process.execPath, [releaseIdentityScript], {
      cwd: repo,
      env: {
        ...process.env,
        EVENT_NAME: 'push',
        PUSH_TAG: 'v1.2.3',
        GITHUB_WORKSPACE: repo,
        GITHUB_OUTPUT: outputPath,
      },
    })

    expect(readFileSync(outputPath, 'utf8')).toBe([
      'tag=v1.2.3',
      'prerelease=false',
      'should_release=true',
      `source_ref=${head}`,
      '',
    ].join('\n'))
  })
})
