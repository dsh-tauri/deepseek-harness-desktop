import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { loadBumpConfig, versionBump } from 'bumpp'
import { readReleaseIdentity } from '../../scripts/release-identity.mjs'

const { parse } = createRequire(import.meta.resolve('bumpp'))('yaml')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const root = mkdtempSync(path.join(tmpdir(), 'dsh-mobile-release-'))
const version = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version === '0.3.0-pre.alpha.1' ? '0.3.0-pre.alpha.2' : '0.3.0-pre.alpha.1'
const files = ['package.json', 'apps/desktop/package.json', 'apps/native/package.json', 'apps/native/app.json', 'apps/desktop/src-tauri/Cargo.toml', 'apps/desktop/src-tauri/Cargo.lock', 'apps/desktop/src-tauri/tauri.conf.json']
const original = files.map(file => readFileSync(path.join(repo, file), 'utf8'))
const json = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'))

const app = JSON.parse(readFileSync(path.join(repo, 'apps/native/app.json'), 'utf8')).expo
const eas = JSON.parse(readFileSync(path.join(repo, 'apps/native/eas.json'), 'utf8'))
assert.equal(app.android?.package, 'com.dshtauri.dshbridge', 'android package')
assert.equal(app.ios?.bundleIdentifier, 'com.dshtauri.dshbridge', 'ios bundle identifier')
assert.equal(app.scheme, 'dshbridge', 'url scheme')
assert.equal(app.ios?.config?.usesNonExemptEncryption, false, 'ios export compliance')
assert.equal(eas.cli?.appVersionSource, 'remote', 'eas appVersionSource')
assert.equal(eas.build?.production?.autoIncrement, true, 'eas production autoIncrement')
for (const [name, key] of [['expo-camera', 'cameraPermission'], ['expo-secure-store', 'faceIDPermission'], ['expo-notifications', 'mode']]) {
  const entry = app.plugins?.find(plugin => Array.isArray(plugin) && plugin[0] === name)
  assert.ok(entry, `${name} plugin`)
  assert.ok(key in (entry[1] ?? {}), `${name} ${key}`)
}
function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30000 })
  assert.ifError(result.error)
  return result
}
function git(...args) {
  const result = run('git', args)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
function step(file, name) {
  const workflow = parse(readFileSync(path.join(repo, '.github/workflows', file), 'utf8'))
  return Object.values(workflow.jobs).flatMap(job => job.steps ?? []).find(item => item.name === name).run
}
try {
  for (const file of files) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    copyFileSync(path.join(repo, file), path.join(root, file))
  }
  const code = json('apps/native/app.json').expo.android.versionCode
  const options = await loadBumpConfig({ configFilePath: path.join(repo, 'bump.config.ts'), release: version, commit: false, tag: false, push: false, confirm: false, ignoreScripts: true, printCommits: false }, root)
  await versionBump({ ...options, cwd: root })
  assert.equal(readReleaseIdentity(root).version, version)
  const cargoName = readFileSync(path.join(root, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8').match(/^name = "([^"]+)"/m)[1]
  const lockPackage = readFileSync(path.join(root, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8').split('[[package]]').find(block => block.includes(`name = "${cargoName}"`))
  assert.ok(lockPackage.includes(`version = "${version}"`), 'Cargo.lock package version')
  for (const file of ['package.json', 'apps/desktop/package.json', 'apps/native/package.json', 'apps/desktop/src-tauri/tauri.conf.json'])
    assert.equal(json(file).version, version, file)
  assert.equal(json('apps/native/app.json').expo.version, version)
  assert.equal(json('apps/native/app.json').expo.android.versionCode, code + 1)
  mkdirSync(path.join(root, 'scripts'))
  copyFileSync(path.join(repo, 'scripts/release-identity.mjs'), path.join(root, 'scripts/release-identity.mjs'))
  const nativeFile = path.join(root, 'apps/native/app.json')
  const native = readFileSync(nativeFile, 'utf8')
  const output = path.join(root, 'outputs')
  for (const [workflow, name] of [['build-ios.yml', 'Read version and normalize iOS marketing version'], ['release-testflight.yml', 'Normalize marketing version and stamp unique build before prebuild']]) {
    const [, type, body] = step(workflow, name).match(/node --input-type=(\w+) <<'NODE'\n([\s\S]*?)\nNODE/)
    const stamp = run(process.execPath, [`--input-type=${type}`, '-e', body], { GITHUB_OUTPUT: output, GITHUB_ENV: output, BUILD_NUMBER: '1234.56.78' })
    assert.equal(stamp.status, 0, stamp.stdout + stamp.stderr)
    assert.equal(json('apps/native/app.json').expo.version, '0.3.0')
    writeFileSync(nativeFile, native)
  }
  git('init', '-b', 'main')
  git('add', '.')
  git('-c', 'user.name=Release Check', '-c', 'user.email=release-check@example.invalid', 'commit', '-m', 'fixture')
  const source = git('rev-parse', 'HEAD')
  git('tag', `v${version}`)
  git('update-ref', 'refs/remotes/origin/main', source)
  const guard = run('bash', ['-c', `gh() { return 0; }; ${step('release-native.yml', 'Resolve release tag')}`], { EVENT_NAME: 'workflow_dispatch', TAG_INPUT: `v${version}`, GITHUB_OUTPUT: output })
  assert.equal(guard.status, 0, guard.stdout + guard.stderr)
  assert.match(readFileSync(output, 'utf8'), /should_build=true/)
  const validation = step('release-testflight.yml', 'Validate and checkout immutable official source')
  const trusted = run('bash', ['-c', validation], { SOURCE_REF: source, GITHUB_ENV: output })
  assert.equal(trusted.status, 0, trusted.stdout + trusted.stderr)
  git('checkout', '--orphan', 'untrusted')
  git('-c', 'user.name=Release Check', '-c', 'user.email=release-check@example.invalid', 'commit', '--allow-empty', '-m', 'untrusted')
  const rejected = run('bash', ['-c', validation], { SOURCE_REF: git('rev-parse', 'HEAD'), GITHUB_ENV: output })
  assert.notEqual(rejected.status, 0, 'Untrusted commits must not receive signing credentials')
  const symbolic = run('bash', ['-c', validation], { SOURCE_REF: 'main', GITHUB_ENV: output })
  assert.notEqual(symbolic.status, 0, 'Mutable branch names must not receive signing credentials')
  assert.deepEqual(files.map(file => readFileSync(path.join(repo, file), 'utf8')), original, 'The real workspace must remain unchanged')
  console.log('Verified real bumpp version propagation, native tag acceptance and trusted main source isolation.')
}
finally {
  rmSync(root, { recursive: true, force: true })
}
