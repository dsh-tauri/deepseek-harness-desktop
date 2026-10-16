import type { VersionBumpOptions } from 'bumpp'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { versionBump } from 'bumpp'
import { describe, expect, it } from 'vitest'
import bumpConfig from '../bump.config'
import { readSource } from './setup/read-source'

const android = readSource('.github/workflows/build-android.yml')
const ios = readSource('.github/workflows/build-ios.yml')
const release = readSource('.github/workflows/release-native.yml')

function section(source: string, key: string, indent = 0): string {
  const body = source.match(new RegExp(`^${' '.repeat(indent)}${key}:([\\s\\S]*?)(?=^ {0,${indent}}\\S|(?![\\s\\S]))`, 'm'))?.[1]
  expect(body, key).toBeTypeOf('string')
  return body!
}

function scratch<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'mobile-release-'))
  try {
    return run(directory)
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('mobile release workflow contracts', () => {
  it.each([
    ['Android build', android, ['workflow_dispatch', 'workflow_call']],
    ['Android test', readSource('.github/workflows/build-android-test.yml'), ['workflow_dispatch']],
    ['iOS build', ios, ['workflow_call']],
    ['iOS test', readSource('.github/workflows/build-ios-test.yml'), ['workflow_dispatch']],
  ])('%s packages only on explicit or reusable workflow triggers', (_name, source, triggers) => {
    const events = [...section(source, 'on').matchAll(/^ {2}(\w+):/gm)].map(match => match[1])
    expect(events).toEqual(triggers)
    expect(section(source, 'permissions')).toContain('contents: read')
    expect(source).not.toMatch(/contents: write|gh release (?:create|edit|upload)/)
  })

  it('follows successful same-repository desktop releases without writing release metadata', () => {
    expect(section(release, 'on')).toContain('workflows: [\'Build & Release\']')
    expect(section(release, 'on')).toContain('types: [completed]')
    expect(readSource('.github/workflows/release.yml')).toMatch(/^name: Build & Release$/m)
    const prepare = section(release, 'prepare', 2)
    expect(prepare).toContain('github.event.workflow_run.conclusion == \'success\'')
    expect(prepare).toContain('github.event.workflow_run.head_repository.full_name == github.repository')
    expect(prepare).toContain('github.event.workflow_run.head_sha || github.sha')
    expect(prepare).toContain('persist-credentials: false')
    expect(prepare).toContain('actions: read')
    expect(prepare).toContain(`RUN_ID: \${{ github.event.workflow_run.id }}`)
    expect(section(release, 'permissions')).toContain('contents: read')
    expect(section(release, 'publish', 2)).toContain('contents: write')
    expect(release).not.toMatch(/gh release (?:create|edit)/)
  })

  it.each([
    ['push', 'v0.23.3-beta.0', 'success', true],
    ['push', 'main', 'success', true],
    ['pull_request', 'release/v0.23.3-beta.0', 'success', true],
    ['pull_request', 'release/v0.23.3-beta.0', 'skipped', false],
    ['pull_request', 'feature/native', 'skipped', false],
    ['push', 'main', 'failure', false],
    ['push', 'main', '', false],
    ['workflow_dispatch', 'main', 'success', false],
  ])('desktop %s from %s with finalize %s enables mobile builds: %s', (event, branch, finalized, allowed) => {
    const script = release.match(/ {6}- name: Resolve release tag\n[\s\S]*? {8}run: \|\n([\s\S]*?)(?=^ {2}\S)/m)?.[1]
    expect(script).toBeTypeOf('string')
    const result = scratch((directory) => {
      const output = join(directory, 'output')
      const executed = spawnSync(process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash', ['-c', `
        node() { printf '%s\\n' '0.23.3-beta.0'; }
        gh() {
          if [ "$1" = run ]; then
            [ "$2" = view ] && [ "$3" = 123 ] && [ "$4" = --json ] && [ "$5" = jobs ] && [ "$6" = --jq ] && [ "$7" = '.jobs[] | select(.name == "Publish GitHub Release") | .conclusion' ] || return 1
            printf '%s\\n' "$FINALIZE_CONCLUSION"
          fi
        }
        git() { if [ "$1" = rev-parse ]; then printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; fi; }
        ${script}
      `], {
        stdio: 'ignore',
        timeout: 10000,
        env: { ...process.env, EVENT_NAME: 'workflow_run', TRIGGER_EVENT: event, RUN_HEAD_BRANCH: branch, RUN_ID: '123', FINALIZE_CONCLUSION: finalized, TAG_INPUT: '', GITHUB_OUTPUT: output.replace(/\\/g, '/') },
      })
      expect(executed.error).toBeUndefined()
      expect(executed.status).toBe(0)
      return readFileSync(output, 'utf8')
    })
    expect(result).toContain(`should_build=${allowed}\n`)
    expect(result).toContain(`source_ref=${allowed ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : ''}\n`)
  })

  it.each([
    ['build', android, 'android-apk', `Deepseek.Harness.Android_\${VERSION}.apk`, 'SHA256SUMS-Android.txt'],
    ['build-ios', ios, 'ios-ipa', `Deepseek.Harness.iOS_\${VERSION}_unsigned.ipa`, 'SHA256SUMS-iOS.txt'],
  ])('%s builds the resolved release commit and publishes its exact artifact contract', (job, source, artifact, asset, checksum) => {
    expect(section(source, 'on')).toContain('source_ref:')
    expect(section(source, 'on')).toContain('type: string')
    expect(section(source, 'on')).toContain(`value: \${{ jobs.build.outputs.version }}`)
    expect(source).toMatch(/ref: \$\{\{ inputs\.source_ref(?: \|\| github\.sha)? \}\}/)
    expect(source).toContain('persist-credentials: false')
    const build = section(release, job, 2)
    expect(build).toContain('if: needs.prepare.outputs.should_build == \'true\'')
    expect(build).toContain(`source_ref: \${{ needs.prepare.outputs.source_ref }}`)
    expect(source).toContain(`name: ${artifact}-\${{ steps.meta.outputs.version }}`)
    expect(source).toContain('if-no-files-found: error')
    expect(source).toContain(asset)
    expect(source).toContain(`> ${checksum}`)
    const publish = section(release, 'publish', 2)
    expect(publish).toContain(`needs.${job}.result == 'success'`)
    expect(publish).toContain(`name: ${artifact}-\${{ needs.${job}.outputs.version }}`)
    expect(publish).toContain(asset)
    expect(publish).toContain(`release/${checksum}`)
    expect(publish).toContain(`RELEASE_TAG: \${{ needs.prepare.outputs.tag }}`)
    expect(publish).toContain('gh release upload "$RELEASE_TAG"')
  })

  it('isolates TestFlight signing from unsigned mobile release assets', () => {
    const job = section(release, 'testflight', 2)
    expect(job).toContain('github.repository == \'dsh-tauri/deepseek-harness-desktop\'')
    expect(job).toContain('vars.IOS_TESTFLIGHT_ENABLED == \'true\'')
    expect(job).toContain('needs.prepare.outputs.should_build == \'true\'')
    expect(job).toContain('uses: ./.github/workflows/release-testflight.yml')
    expect(job).toContain(`source_ref: \${{ needs.prepare.outputs.source_ref }}`)
    const secrets = [
      'APPLE_TEAM_ID',
      'IOS_DISTRIBUTION_CERTIFICATE',
      'IOS_DISTRIBUTION_CERTIFICATE_PASSWORD',
      'IOS_PROVISIONING_PROFILE',
      'APP_STORE_CONNECT_API_KEY',
      'APP_STORE_CONNECT_KEY_ID',
      'APP_STORE_CONNECT_ISSUER_ID',
    ]
    for (const name of secrets)
      expect(job).toContain(`${name}: \${{ secrets.${name} }}`)
    expect(section(release, 'publish', 2)).toContain('needs: [prepare, build, build-ios]')
    expect(section(release, 'publish', 2)).not.toContain('needs.testflight')
    expect(section(release, 'build-ios', 2)).not.toContain('secrets:')
  })

  it('gates external Beta review after upload and before credential cleanup', () => {
    const signed = readSource('.github/workflows/release-testflight.yml')
    const upload = signed.indexOf('- name: Upload the same IPA to App Store Connect')
    const review = signed.indexOf('- name: Submit external Beta review and enable automatic tester notifications')
    const cleanup = signed.indexOf('- name: Always remove temporary signing material')
    expect(upload).toBeGreaterThan(-1)
    expect(review).toBeGreaterThan(upload)
    expect(cleanup).toBeGreaterThan(review)
    const step = signed.slice(review, cleanup)
    expect(step).toContain('if: vars.IOS_BETA_REVIEW_ENABLED == \'true\'')
    expect(step).toContain('timeout-minutes: 35')
    expect(step).toContain(`TESTFLIGHT_BETA_GROUP_ID: \${{ vars.TESTFLIGHT_BETA_GROUP_ID }}`)
    expect(step).toContain('run: python3 .github/scripts/ios-beta-review.py')
    expect(readSource('.github/workflows/ci.yml')).toContain('-p \'test_ios_*.py\'')
  })

  it('recovers review of an existing build without signing or uploading another IPA', () => {
    const recovery = readSource('.github/workflows/review-testflight.yml')
    expect([...section(recovery, 'on').matchAll(/^ {2}(\w+):/gm)].map(match => match[1])).toEqual(['workflow_dispatch'])
    expect(recovery).toContain('github.repository == \'dsh-tauri/deepseek-harness-desktop\'')
    expect(recovery).toContain('github.ref == \'refs/heads/main\'')
    expect(recovery).toContain('vars.IOS_BETA_REVIEW_ENABLED == \'true\'')
    expect(recovery).toContain('group: ios-testflight-distribution')
    for (const name of ['ios_version', 'build_number', 'source_sha'])
      expect(recovery).toContain(`${name}:`)
    expect(recovery).toContain('git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main')
    expect(recovery).toContain('run: python3 .github/scripts/ios-beta-review.py')
    expect(recovery).toContain('if: always()')
    expect(recovery).not.toMatch(/IOS_DISTRIBUTION_CERTIFICATE|IOS_PROVISIONING_PROFILE|xcodebuild|altool|workflow_run/)
  })

  it('pins TestFlight to the locally verified Xcode toolchain on macOS 26', () => {
    const signed = readSource('.github/workflows/release-testflight.yml')
    expect(signed).toContain('runs-on: macos-26')
    expect(signed).toContain('xcode-version: 26.4.1')
    expect(signed).not.toContain('runs-on: macos-15-intel')
  })

  it('keeps the native version synchronized with the desktop version', () => {
    expect(JSON.parse(readSource('app.json')).expo.version).toBe(JSON.parse(readSource('package.json')).version)
    expect(bumpConfig.files).toContain('app.json')
  })

  it('installed bumpp updates Expo beta version and increments Android versionCode once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mobile-bump-'))
    try {
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'mobile-bump-test', version: '0.23.2' }))
      writeFileSync(join(directory, 'app.json'), JSON.stringify({ expo: { version: '0.23.2', android: { versionCode: 21006 }, extra: { keep: '0.23.2' } } }))
      const options = { cwd: directory, files: ['package.json', 'app.json'], release: '0.23.3-beta.0', commit: false, tag: false, push: false, install: false, confirm: false, ignoreScripts: true, interface: false, printCommits: false } satisfies VersionBumpOptions
      const result = await versionBump(options)
      expect(result.updatedFiles).toContain(join(directory, 'app.json'))
      expect(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version).toBe('0.23.3-beta.0')
      const expected = { expo: { version: '0.23.3-beta.0', android: { versionCode: 21007 }, extra: { keep: '0.23.2' } } }
      expect(JSON.parse(readFileSync(join(directory, 'app.json'), 'utf8'))).toEqual(expected)
      await versionBump(options)
      expect(JSON.parse(readFileSync(join(directory, 'app.json'), 'utf8'))).toEqual(expected)
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
