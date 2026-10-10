import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSource } from './setup/read-source'

const renameScript = fileURLToPath(new URL('../scripts/rename-release-assets.mjs', import.meta.url))
const temporaryRepos: string[] = []

function assetRepo(version: string) {
  const repo = mkdtempSync(path.join(tmpdir(), 'nightly-assets-'))
  temporaryRepos.push(repo)
  mkdirSync(path.join(repo, 'src-tauri'))
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version }))
  writeFileSync(path.join(repo, 'src-tauri/Cargo.toml'), `[package]\nversion = "${version}"\n`)
  writeFileSync(path.join(repo, 'src-tauri/tauri.conf.json'), JSON.stringify({ productName: 'DSH Tauri', version }))
  writeFileSync(path.join(repo, 'src-tauri/tauri.nightly.conf.json'), JSON.stringify({ productName: 'DSH Tauri Nightly' }))
  return repo
}

function renameAssets(repo: string, ...directories: string[]) {
  return execFileSync(process.execPath, [renameScript, ...directories], {
    cwd: repo,
    env: { ...process.env, GITHUB_WORKSPACE: repo },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

afterEach(() => {
  for (const repo of temporaryRepos.splice(0))
    rmSync(repo, { recursive: true, force: true })
})

const WORKFLOW = '.github/workflows/release-nightly.yml'
const UPLOAD_STEPS = ['Upload assets to the draft release', 'Refresh rolling nightly alias']
const PRUNE_STEP = 'Prune stale nightly installer assets'
const repoIdentity = { owner: 'dsh-tauri-desk', repo: 'deepseek-harness-desktop' }

function stepBody(source: string, name: string): string {
  const body = source.match(new RegExp(` {6}- name: ${name}\\n([\\s\\S]*?)(?=\\n {6}- |$)`))?.[1]
  expect(body, name).toBeTypeOf('string')
  return body ?? ''
}

async function pruneAssets(runnerTemp: string, tag: string, releases: Map<string, { id: number, assets: { id: number, name: string }[] }>) {
  const body = stepBody(readSource(WORKFLOW), PRUNE_STEP)
  const script = body.split('script: |\n')[1]
  expect(script).toBeTypeOf('string')
  const github = {
    rest: {
      repos: {
        getReleaseByTag: vi.fn(async ({ tag: releaseTag }: { tag: string }) => ({ data: { id: releases.get(releaseTag)!.id } })),
        listReleaseAssets: vi.fn(),
        deleteReleaseAsset: vi.fn(async ({ asset_id }: { asset_id: number }) => {
          for (const release of releases.values())
            release.assets = release.assets.filter(asset => asset.id !== asset_id)
        }),
      },
    },
    paginate: vi.fn(async (_method, { release_id }: { release_id: number }) => {
      return [...releases.values()].find(release => release.id === release_id)!.assets.slice()
    }),
  }
  await runInNewContext(`(async () => {\n${script}\n})()`, {
    github,
    context: { repo: repoIdentity },
    require: createRequire(import.meta.url),
    process: { env: { RUNNER_TEMP: runnerTemp, NIGHTLY_TAG: tag } },
  }, { timeout: 1000 })
  return github
}

describe('nightly release notes', () => {
  it.each([false, true])('composes fresh notes on repeated publication with changelog missing: %s', (missing) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'nightly-notes-'))
    temporaryRepos.push(directory)
    if (!missing)
      writeFileSync(path.join(directory, 'nightly_changelog.md'), '### Bug Fixes\n- Fixed nightly publishing\n')
    writeFileSync(path.join(directory, 'nightly_notes.md'), 'stale notes\n### Artifacts\n')
    const body = stepBody(readSource(WORKFLOW), 'Compose release notes')
    const script = body.split('run: |\n')[1]!.replace(/^ {10}/gm, '')
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
    const execute = () => execFileSync(bash, ['-c', `gh() { printf '%s\\n' "$*" > published.txt; }\n${script}`], {
      cwd: directory,
      env: { ...process.env, RUNNER_TEMP: directory.replace(/\\/g, '/'), NIGHTLY_TAG: 'nightly-20261009', NIGHTLY_SHA: 'abc1234', NIGHTLY_DESCRIPTION: 'Nightly warning' },
      encoding: 'utf8',
      timeout: 5000,
    })
    if (missing) {
      expect(execute).toThrow()
      expect(readdirSync(directory)).not.toContain('published.txt')
      return
    }
    execute()
    const notes = readFileSync(path.join(directory, 'nightly_notes.md'), 'utf8')
    expect(notes).toContain('Nightly warning\n\n### Bug Fixes\n- Fixed nightly publishing\n')
    expect(notes).not.toContain('stale notes')
    expect(notes.match(/### 📦 Artifacts/g)).toHaveLength(1)
    expect(notes).toContain('<!-- nightly-sha:abc1234 -->')
    expect(readFileSync(path.join(directory, 'published.txt'), 'utf8')).toContain('--notes-file nightly_notes.md --draft=false --prerelease --latest=false')
  })

  it('generates changelog locally without creating a second release', () => {
    const body = stepBody(readSource(WORKFLOW), 'Generate changelog')
    expect(body).toContain('--output "$RUNNER_TEMP/nightly_changelog.md"')
    expect(body).not.toContain('--draft')
    expect(body).not.toMatch(/pnpm exec changelogithub[^\n]*\|\|/)
  })

  it('publishes the generated changelog instead of rereading an ambiguous release tag', () => {
    const body = stepBody(readSource(WORKFLOW), 'Compose release notes')
    expect(body).toContain('cat "$RUNNER_TEMP/nightly_changelog.md"')
    expect(body).toContain('printf \'%s\\n\' "$NIGHTLY_DESCRIPTION"')
    expect(body).not.toContain('gh release view')
    expect(body).toContain('--notes-file nightly_notes.md --draft=false --prerelease --latest=false')
  })
})

describe('nightly release assets', () => {
  it.each([
    { product: 'DSH Tauri', version: '0.22.4' },
    { product: 'DSH Tauri Nightly', version: '0.0.0-nightly.20261007.gabc1234' },
  ])('normalizes $product bundles without changing their bytes or architecture suffixes', ({ product, version }) => {
    const repo = assetRepo(version)
    const suffixes = ['x64-setup.exe', 'x64_en-US.msi', 'x64_zh-CN.msi', 'aarch64.dmg', 'x64.dmg', 'amd64.AppImage', 'amd64.deb', 'amd64.AppImage.sig']
    const directories = suffixes.map((suffix, index) => {
      const directory = path.join(repo, 'bundle', String(index))
      mkdirSync(directory, { recursive: true })
      writeFileSync(path.join(directory, `${product}_${version}_${suffix}`), `signed-${suffix}`)
      mkdirSync(path.join(directory, 'intermediate'))
      return directory
    })

    renameAssets(repo, ...directories)
    for (const [index, suffix] of suffixes.entries()) {
      const directory = directories[index]!
      const filename = `Deepseek.Harness.Desktop_${version}_${suffix}`
      expect(readdirSync(directory).sort()).toEqual([filename, 'intermediate'].sort())
      expect(readFileSync(path.join(directory, filename), 'utf8')).toBe(`signed-${suffix}`)
    }
    renameAssets(repo, ...directories)
  })

  it('refuses to overwrite an existing downloadable asset', () => {
    const repo = assetRepo('0.22.4')
    const original = path.join(repo, 'DSH Tauri_0.22.4_x64-setup.exe')
    const target = path.join(repo, 'Deepseek.Harness.Desktop_0.22.4_x64-setup.exe')
    writeFileSync(original, 'new installer')
    writeFileSync(target, 'already signed installer')

    expect(() => renameAssets(repo, repo)).toThrow('RELEASE_ASSET_EXISTS:')
    expect(readFileSync(original, 'utf8')).toBe('new installer')
    expect(readFileSync(target, 'utf8')).toBe('already signed installer')
  })

  it.each([
    { filename: null, error: 'RELEASE_ASSETS_EMPTY:' },
    { filename: 'Other_0.22.4_x64-setup.exe', error: 'RELEASE_ASSET_NAME:' },
  ])('rejects missing or unexpected bundles: $filename', ({ filename, error }) => {
    const repo = assetRepo('0.22.4')
    if (filename)
      writeFileSync(path.join(repo, filename), 'unexpected installer')
    expect(() => renameAssets(repo, repo)).toThrow(error)
  })

  it('injects a unique zero-base nightly SemVer and applies the native overlay on all platforms', () => {
    const source = readSource(WORKFLOW)
    expect(stepBody(source, 'Plan nightly version')).toMatch(/version="0\.0\.0-nightly\.\$date\.g\$\{source_ref:0:7\}"/)
    for (const platform of ['windows', 'linux', 'macos']) {
      const build = readSource(`.github/workflows/build-${platform}.yml`)
      expect(build).toContain('inputs.version != \'\' && \'--config src-tauri/tauri.nightly.conf.json\' || \'\'')
      expect(build.indexOf('node scripts/rename-release-assets.mjs')).toBeGreaterThan(build.indexOf('pnpm tauri build'))
      expect(build.indexOf('node scripts/rename-release-assets.mjs')).toBeLessThan(build.indexOf('uses: actions/upload-artifact@'))
    }
  })

  it('unsigned builds exercise nightly identity and asset naming without publishing a release', () => {
    const source = readSource('.github/workflows/build-test.yml')
    expect(source).toMatch(/nightly:\n\s+description: [^\n]+\n\s+required: false\n\s+default: false\n\s+type: boolean/)
    expect(source.match(/node scripts\/stamp-version\.mjs 0\.0\.0-nightly\.test/g)).toHaveLength(3)
    expect(source.match(/inputs\.nightly && '--config src-tauri\/tauri\.nightly\.conf\.json' \|\| ''/g)).toHaveLength(3)
    expect(source.match(/node scripts\/rename-release-assets\.mjs/g)).toHaveLength(3)
    expect(source).toContain('pnpm tauri build --bundles appimage,deb')
    expect(source.indexOf('- name: Stamp nightly version', source.indexOf('  windows:')))
      .toBeLessThan(source.indexOf('- name: Prepare MSI version override'))
    expect(source).toContain('contents: read')
    expect(source).not.toMatch(/gh release|contents: write/)
  })

  it('prunes stale assets only after both uploads succeed', () => {
    const source = readSource(WORKFLOW)
    const cleanup = stepBody(source, PRUNE_STEP)
    expect(cleanup).toContain('uses: actions/github-script@v8')
    expect(cleanup).toMatch(/if: success\(\)/)
    for (const name of UPLOAD_STEPS) {
      const body = stepBody(source, name)
      expect(body, name).toContain('gh release upload')
      expect(body, name).toContain('--clobber')
      expect(body, name).toContain('set -euo pipefail')
      expect(body, name).not.toMatch(/continue-on-error|\|\| true/)
      expect(source.indexOf(`- name: ${PRUNE_STEP}`)).toBeGreaterThan(source.indexOf(`- name: ${name}`))
    }
  })

  it.each(['nightly-20261007', 'nightly-20261008'])('keeps only the current installers after rebuilding %s without touching other assets', async (tag) => {
    const runnerTemp = assetRepo('0.0.0-nightly.20261007.gabc1234')
    const assetsDir = path.join(runnerTemp, 'release-assets')
    mkdirSync(path.join(assetsDir, 'windows'), { recursive: true })
    const preserved = [
      'notes.txt',
      'Deepseek.Harness.Desktop_0.0.0-nightly.20261006.gabc1234_notes.txt',
      'Deepseek.Harness.Desktop_0.22.4_x64-setup.exe',
      'Deepseek.Harness.Desktop_0.0.0-beta.1_x64-setup.exe',
      'Other_0.0.0-nightly.20261006.gabc1234_x64-setup.exe',
    ]
    const suffixes = ['x64-setup.exe', 'x64_en-US.msi', 'aarch64.dmg', 'amd64.AppImage', 'amd64.deb', 'amd64.AppImage.sig']
    const legacy = suffixes.map(suffix => `Deepseek.Harness.Desktop_0.0.0_${suffix}`)
    let nextId = 1
    const releases = new Map([
      ['nightly-20261007', { id: 10, assets: [...preserved, ...legacy].map(name => ({ id: nextId++, name })) }],
      ['nightly', { id: 20, assets: [...preserved, ...legacy].map(name => ({ id: nextId++, name })) }],
    ])
    if (!releases.has(tag))
      releases.set(tag, { id: 30, assets: preserved.map(name => ({ id: nextId++, name })) })

    for (const [day, sha] of [['20261007', 'abc1234'], [tag.slice('nightly-'.length), 'def5678']]) {
      const manifest = suffixes.map(suffix => `Deepseek.Harness.Desktop_0.0.0-nightly.${day}.g${sha}_${suffix}`)
      for (const file of readdirSync(path.join(assetsDir, 'windows')))
        rmSync(path.join(assetsDir, 'windows', file))
      for (const name of manifest)
        writeFileSync(path.join(assetsDir, 'windows', name), 'signed installer')
      const currentTag = day === '20261007' && sha === 'abc1234' ? 'nightly-20261007' : tag
      for (const releaseTag of [currentTag, 'nightly'])
        releases.get(releaseTag)!.assets.push(...manifest.map(name => ({ id: nextId++, name })))
      const github = await pruneAssets(runnerTemp, currentTag, releases)
      for (const releaseTag of [currentTag, 'nightly']) {
        const release = releases.get(releaseTag)!
        expect(release.assets.map(asset => asset.name).sort()).toEqual([...preserved, ...manifest].sort())
        expect(github.rest.repos.getReleaseByTag).toHaveBeenCalledWith({ ...repoIdentity, tag: releaseTag })
        expect(github.paginate).toHaveBeenCalledWith(github.rest.repos.listReleaseAssets, { ...repoIdentity, release_id: release.id, per_page: 100 })
      }
      expect(github.rest.repos.deleteReleaseAsset).toHaveBeenCalled()
      for (const [params] of github.rest.repos.deleteReleaseAsset.mock.calls)
        expect(params).toEqual({ ...repoIdentity, asset_id: expect.any(Number) })
    }
  })

  it('keeps downloaded assets outside the workspace that checkout wipes', () => {
    const lines = readSource(WORKFLOW)
      .split('\n')
      .filter(line => line.includes('release-assets') && !line.trimStart().startsWith('#'))
    expect(lines.length).toBeGreaterThan(3)
    for (const line of lines) {
      expect(line.includes('RUNNER_TEMP') || line.includes('runner.temp'), line).toBe(true)
    }
  })
})
