import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function check(name, fn) {
  fn()
  process.stdout.write(`${name}\n`)
}

const root = resolve(import.meta.dirname, '..')
mkdirSync(join(root, '.temp'), { recursive: true })
const work = mkdtempSync(join(root, '.temp/copr-check-'))
const repo = join(work, 'repo')
const bin = join(work, 'bin')
mkdirSync(bin)
function put(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20000, ...options })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.stdout
}
const realGit = run('bash', ['-c', 'command -v git']).trim()
cpSync(join(root, '.copr'), join(repo, '.copr'), { recursive: true })
put(join(repo, 'package.json'), '{\n  "version": "0.3.0-pre.alpha.2",\n  "packageManager": "pnpm@11.7.0"\n}\n')
for (const file of ['apps/desktop/src-tauri/Cargo.toml', 'apps/desktop/src-tauri/tauri.conf.json', 'packages/builtin-plugin-remote/src/host/utils/assets.ts']) {
  const dest = join(repo, file)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(join(root, file), dest)
}
run('git', ['init', '-q', repo])
run('git', ['-C', repo, 'add', '.'])
for (const name of ['tauri-runtime-electron', 'electron-rs', 'tauri-plugin-notifications']) {
  const dir = join(repo, 'crates', name)
  mkdirSync(dir, { recursive: true })
  run('git', ['init', '-q', dir])
  put(join(dir, 'Cargo.toml'), '[package]\nname = "fixture"\n')
  run('git', ['-C', dir, 'add', 'Cargo.toml'])
  put(join(dir, 'untracked-secret'), 'must not ship')
}
put(join(repo, 'source/old-platform'), 'must not ship')
put(join(repo, '.temp-sentinel'), 'must not ship')
put(join(bin, 'git'), `#!/bin/bash\ncase " $* " in\n*" tag --points-at HEAD "*) printf "%s\\n" "$TEST_TAGS" ;;\n*" log -1 "*) echo "Packager <packager@example.test>" ;;\n*" submodule update --init "*) exit 0 ;;\n*) exec "${realGit}" "$@" ;;\nesac\n`)
put(join(bin, 'rpmbuild'), '#!/bin/bash\nset -eu\nwhile [ "$#" -gt 0 ]; do\ncase "$1" in\n--define) case "$2" in\n"_sourcedir "*) source_dir=$(printf "%s" "$2" | cut -d " " -f 2-) ;;\n"_srcrpmdir "*) output=$(printf "%s" "$2" | cut -d " " -f 2-) ;;\nesac; shift 2 ;;\n-bs) shift ;;\n*) spec=$1; shift ;;\nesac\ndone\ncp "$spec" "$output/result.spec"\ncp "$source_dir/"*.tar.gz "$output/source.tar.gz"\n')
run('bash', ['-c', 'chmod +x "$1"/*', '_', bin])
function build(name, tags) {
  return spawnSync('bash', ['-c', 'export PATH="$(cd "$1" && pwd):$PATH"; export TMPDIR="$(cd "$2" && pwd)"; bash "$3/.copr/srpm.sh" "$2/output" "$4"', '_', bin, work, repo, name], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, TEST_TAGS: tags },
  })
}
check('SRPM rejects non-release refs, invalid channels and prereleases on stable', () => {
  for (const [name, tags, error] of [
    ['dsh-tauri-beta', '', 'SRPM_NOT_RELEASE'],
    ['dsh-tauri', 'v0.3.0-pre.alpha.2', 'SRPM_PRERELEASE_SKIPPED'],
    ['other', '', 'SRPM_PACKAGE_INVALID'],
  ]) {
    const result = build(name, tags)
    assert.ifError(result.error)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stderr, new RegExp(error))
  }
})
check('SRPM fills Next metadata, picks highest release and includes required submodule sources', () => {
  const result = build('dsh-tauri-beta', 'v0.3.0-pre.alpha.2\ncopr/0.3.0-pre.alpha.2-3\ncopr/0.3.0-pre.alpha.2-2')
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const spec = readFileSync(join(work, 'output/result.spec'), 'utf8')
  assert.match(spec, /Version:\s+0\.3\.0~pre\.alpha\.2/)
  assert.match(spec, /Release:\s+3%\{\?dist\}/)
  assert.match(spec, /Summary:\s+Desktop application for DeepSeek Harness \(dsh\)/)
  assert.match(spec, /MimeType=x-scheme-handler\/dsh/)
  assert.doesNotMatch(spec, /@[A-Z_]+@/)
  const files = run('bash', ['-c', 'tar -tzf source.tar.gz', '_'], { cwd: join(work, 'output') }).trim().split('\n')
  for (const name of ['tauri-runtime-electron', 'electron-rs', 'tauri-plugin-notifications']) {
    assert.ok(files.includes(`dsh-tauri-beta-0.3.0~pre.alpha.2/crates/${name}/Cargo.toml`))
  }
  assert.ok(files.every(file => !/untracked-secret|\/source\/|\.temp-sentinel|\/\.git\//.test(file)))
  const source = join(repo, 'apps/desktop/src-tauri')
  for (const file of ['target/release/deepseek-harness-desktop', 'resources/manifest.jsonc', 'target/electron/linux-x64/electron', 'target/electron/linux-x64/chrome-sandbox', 'target/electron/linux-x64/runtime/main.cjs', 'icons/32x32.png', 'icons/128x128.png', 'icons/128x128@2x.png', 'icons/icon.png']) {
    put(join(source, file), file)
  }
  const buildroot = join(work, 'buildroot').replaceAll('\\', '/')
  const macros = { buildroot, appdir: '/usr/lib/DeepSeek Harness', _bindir: '/usr/bin', _datadir: '/usr/share', binname: 'deepseek-harness-desktop', appname: 'DeepSeek Harness', summary: 'Desktop application for DeepSeek Harness (dsh)' }
  const install = spec.split('\n%install\n')[1].split('\n%files\n')[0]
    .replace(/%\{(\w+)\}/g, (_, key) => {
      assert.ok(Object.hasOwn(macros, key), key)
      return macros[key]
    })
  run('bash', ['-eu', '-c', install], { cwd: repo })
  assert.equal(readFileSync(join(buildroot, 'usr/lib/DeepSeek Harness/runtime/linux-x64/runtime/main.cjs'), 'utf8'), 'target/electron/linux-x64/runtime/main.cjs')
  assert.equal(readFileSync(join(buildroot, 'usr/lib/DeepSeek Harness/resources/manifest.jsonc'), 'utf8'), 'resources/manifest.jsonc')
  assert.match(readFileSync(join(buildroot, 'usr/share/applications/DeepSeek Harness.desktop'), 'utf8'), /Exec=deepseek-harness-desktop[\s\S]*MimeType=x-scheme-handler\/dsh/)
})
check('SRPM keeps cross-arch Tailwind bindings out of automatic requires', () => {
  const result = build('dsh-tauri-beta', 'v0.3.0-pre.alpha.2')
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const lines = readFileSync(join(work, 'output/result.spec'), 'utf8').split('\n')
  function macro(name) {
    const line = lines.find(text => text.startsWith(`%global ${name} `))
    assert.ok(line, `SRPM_MACRO_MISSING: ${name}`)
    return line.slice(`%global ${name} `.length)
  }
  const appdir = macro('appdir').replaceAll('%{_prefix}', '/usr').replaceAll('%{appname}', macro('appname'))
  const pattern = new RegExp(macro('__requires_exclude_from').replaceAll('%{appdir}', appdir))
  for (const arch of ['x64', 'arm64']) {
    assert.match(`${appdir}/resources/node_modules/@tailwindcss/oxide-linux-${arch}-gnu/tailwindcss-oxide.linux-${arch}-gnu.node`, pattern)
  }
  assert.doesNotMatch(`${appdir}/runtime/linux-x64/electron`, pattern)
})
