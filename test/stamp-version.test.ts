import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import * as stampVersionModule from '../scripts/stamp-version.mjs'

interface StampResult {
  version: string
  files: string[]
}

interface StampVersionModule {
  stampCargoToml: (content: string, version: string, label: string) => string
  stampVersion: (repo: string, version: string) => StampResult
}

const stampVersionScript = fileURLToPath(new URL('../scripts/stamp-version.mjs', import.meta.url))
const stamp = stampVersionModule as StampVersionModule

const nightlyVersion = '0.0.0-nightly.20261007.gabc1234'
const temporaryRepos: string[] = []

function readVersion(filePath: string) {
  return (JSON.parse(readFileSync(filePath, 'utf8')) as { version: string }).version
}

function writeRepo(versions: { packageJson: string, cargoToml: string, tauriConfig: string }) {
  const repo = mkdtempSync(path.join(tmpdir(), 'stamp-version-'))
  temporaryRepos.push(repo)
  mkdirSync(path.join(repo, 'src-tauri'))
  writeFileSync(path.join(repo, 'package.json'), [
    '{',
    '  "name": "deepseek-harness-desktop",',
    `  "version": "${versions.packageJson}",`,
    '  "private": true',
    '}',
    '',
  ].join('\n'))
  writeFileSync(path.join(repo, 'src-tauri', 'Cargo.toml'), [
    '[workspace.package]',
    'version = "9.9.9"',
    '',
    '[dependencies]',
    'version = "7.0.0"',
    '',
    '[package] # release identity',
    'name = "deepseek-harness-desktop"',
    `version = "${versions.cargoToml}" # current release`,
    '',
    '[package.metadata.release]',
    'version = "6.0.0"',
    '',
  ].join('\n'))
  writeFileSync(path.join(repo, 'src-tauri', 'tauri.conf.json'), [
    '{',
    '  "productName": "DSH Tauri",',
    `  "version": "${versions.tauriConfig}",`,
    '  "identifier": "dsh-tauri",',
    '  "bundle": {',
    '    "active": true,',
    '    "targets": "all"',
    '  }',
    '}',
    '',
  ].join('\n'))
  return repo
}

afterEach(() => {
  for (const repo of temporaryRepos.splice(0))
    rmSync(repo, { recursive: true, force: true })
})

describe('nightly version stamping', () => {
  it('stamps the injected version into every release file and reports them', () => {
    const repo = writeRepo({ packageJson: '0.22.3', cargoToml: '0.22.3', tauriConfig: '0.22.3' })

    expect(stamp.stampVersion(repo, nightlyVersion)).toEqual({
      version: nightlyVersion,
      files: ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json'],
    })

    expect(readVersion(path.join(repo, 'package.json'))).toBe(nightlyVersion)
    expect(readVersion(path.join(repo, 'src-tauri', 'tauri.conf.json'))).toBe(nightlyVersion)

    const cargo = readFileSync(path.join(repo, 'src-tauri', 'Cargo.toml'), 'utf8')
    expect(cargo).toContain(`version = "${nightlyVersion}" # current release`)
    expect(cargo).toContain('version = "9.9.9"')
    expect(cargo).toContain('version = "7.0.0"')
    expect(cargo).toContain('version = "6.0.0"')
  })

  it('rewrites only the Cargo [package] version', () => {
    const stamped = stamp.stampCargoToml([
      '[workspace.package]',
      'version = "9.9.9"',
      '',
      '[package]',
      'name = "desktop"',
      'version = "0.22.3"',
      '',
    ].join('\n'), nightlyVersion, 'src-tauri/Cargo.toml')

    expect(stamped).toBe([
      '[workspace.package]',
      'version = "9.9.9"',
      '',
      '[package]',
      'name = "desktop"',
      `version = "${nightlyVersion}"`,
      '',
    ].join('\n'))
  })

  it('keeps CRLF line endings', () => {
    const stamped = stamp.stampCargoToml(
      '[package]\r\nname = "desktop"\r\nversion = "0.22.3"\r\n',
      nightlyVersion,
      'src-tauri/Cargo.toml',
    )
    expect(stamped).toBe(`[package]\r\nname = "desktop"\r\nversion = "${nightlyVersion}"\r\n`)
  })

  it('stamps through the CLI entry point using GITHUB_WORKSPACE', () => {
    const repo = writeRepo({ packageJson: '0.22.3', cargoToml: '0.22.3', tauriConfig: '0.22.3' })

    const stdout = execFileSync(process.execPath, [stampVersionScript, nightlyVersion], {
      cwd: tmpdir(),
      env: { ...process.env, GITHUB_WORKSPACE: repo },
      encoding: 'utf8',
    })

    expect(stdout.trim()).toBe(
      `STAMP_VERSION: package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json -> ${nightlyVersion}`,
    )
    expect(readVersion(path.join(repo, 'package.json'))).toBe(nightlyVersion)
  })

  it('rejects a version equal to the checked-out release version', () => {
    const repo = writeRepo({ packageJson: '0.22.3', cargoToml: '0.22.3', tauriConfig: '0.22.3' })
    expect(() => stamp.stampVersion(repo, '0.22.3')).toThrow(
      /^STAMP_VERSION: stamped version 0\.22\.3 equals the checked-out release version$/,
    )
  })

  it.each(['v0.22.3', '0.22.3-nightly.01.abc1234', '0.22.3-nightly.20261007+'])(
    'rejects the non-SemVer version %s',
    (version) => {
      const repo = writeRepo({ packageJson: '0.22.3', cargoToml: '0.22.3', tauriConfig: '0.22.3' })
      expect(() => stamp.stampVersion(repo, version)).toThrow(
        /^STAMP_VERSION: stamped version is not strict SemVer 2\.0/,
      )
    },
  )

  it('rejects mismatched release files before writing anything', () => {
    const repo = writeRepo({ packageJson: '0.22.3', cargoToml: '0.22.4', tauriConfig: '0.22.3' })
    expect(() => stamp.stampVersion(repo, nightlyVersion)).toThrow(/release versions do not match/)
    expect(readVersion(path.join(repo, 'package.json'))).toBe('0.22.3')
  })
})
