import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply } from 'dsh-taiwind'
import { afterEach, expect, it, vi } from 'vitest'
import { pruneDeployment, pruneForeignLibcBindings, verifyRemoteNativeBindings } from './build-plugins.ts'

const roots = []
const optionalWasi = `let nativeBinding = {}
if (!nativeBinding || process.env.NAPI_RS_FORCE_WASI) {
  try { nativeBinding = require('./tailwindcss-oxide.wasi.cjs') } catch {}
  if (!nativeBinding) {
    try { nativeBinding = require('@tailwindcss/oxide-wasm32-wasi') } catch {}
  }
}
module.exports = nativeBinding
`

function fixture(name = '@tailwindcss/oxide', source = optionalWasi, file = 'index.js') {
  const root = mkdtempSync(join(tmpdir(), 'plugin-deploy-'))
  roots.push(root)
  const dir = join(root, name)
  mkdirSync(dirname(join(dir, file)), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js' }))
  writeFileSync(join(dir, 'index.js'), file === 'index.js' ? source : `require('./${file}')`)
  if (file !== 'index.js')
    writeFileSync(join(dir, file), source)
  return { root, dir, names: [name] }
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

it('preserves the oxide entry when its unpublished optional WASI fallback is absent', () => {
  const { root, dir, names } = fixture()
  writeFileSync(join(dir, 'README.md'), 'development documentation')
  pruneDeployment(root, names)
  expect(readFileSync(join(dir, 'index.js'), 'utf8')).toBe(optionalWasi)
  expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toEqual({ name: '@tailwindcss/oxide', main: 'index.js' })
  expect(existsSync(join(dir, 'tailwindcss-oxide.wasi.cjs'))).toBe(false)
  expect(existsSync(join(dir, 'README.md'))).toBe(false)
})

it('compiles declared Tailwind CSS from pruned release resources', async () => {
  const { root, dir, names } = fixture('styled-plugin', '')
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'dist'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'styled-plugin',
    main: 'index.js',
    dsh: { taiwind: 'src/main.css' },
  }))
  writeFileSync(join(dir, 'src/main.css'), '@import "tailwindcss"; @theme { --color-release-accent: #123456; }')
  writeFileSync(join(dir, 'src/development.ts'), 'export const unused = true')
  writeFileSync(join(dir, 'dist/client.cjs'), 'module.exports = "flex bg-release-accent"')
  pruneDeployment(root, names)
  vi.stubEnv('DSH_HOME', join(root, 'home'))
  const cleanups = []
  const warnings = []
  let route
  try {
    await apply({
      clientModules: {
        graph: () => ({ entries: [{ id: 'styled-plugin', rev: 'release' }] }),
        clientPath: () => join(dir, 'dist/client.cjs'),
        onGraphChanged: () => () => {},
        onRebuilt: () => () => {},
      },
      connection: { requestRejection: () => undefined },
      webServer: {
        register: (value) => {
          route = value
          return () => {}
        },
      },
      logger: { warn: message => warnings.push(message) },
      effect: (callback) => { cleanups.push(callback()) },
      on: () => {},
    })
    let status
    let css
    await route.handler({ method: 'GET', headers: {} }, {
      setHeader() {},
      writeHead: (value) => { status = value },
      end: (value) => { css = value },
    })
    await vi.waitFor(() => {
      expect(existsSync(join(root, 'home/taiwind/styles.css'))).toBe(true)
    })
    expect(warnings).toEqual([])
    expect(status).toBe(200)
    expect(css).toContain('.bg-release-accent')
    expect(css).toContain('#123456')
    expect(css).toContain('.flex')
    expect(existsSync(join(dir, 'src/development.ts'))).toBe(false)
  }
  finally {
    for (const cleanup of cleanups.reverse()) cleanup()
  }
})

it('rejects deployment when a declared Tailwind stylesheet is missing', () => {
  const { root, dir, names } = fixture('styled-plugin', '')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'styled-plugin',
    main: 'index.js',
    dsh: { taiwind: 'src/main.css' },
  }))
  expect(() => pruneDeployment(root, names)).toThrow('PLUGIN_DEPLOY_ENTRY_MISSING:')
})

it('preserves relative runtime targets under prunable directories', () => {
  const source = `${optionalWasi}
require('./src/native.cjs')`
  const { root, dir, names } = fixture('@tailwindcss/oxide', source)
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/native.cjs'), 'module.exports = 42')
  pruneDeployment(root, names)
  expect(readFileSync(join(dir, 'src/native.cjs'), 'utf8')).toBe('module.exports = 42')
  expect(readFileSync(join(dir, 'index.js'), 'utf8')).toBe(source)
})

it.each([
  ['require', 'require(\'./required.cjs\')'],
  ['caught require', 'try { require(\'./required.cjs\') } catch (error) { console.error(error) }'],
  ['static import', 'import value from \'./required.cjs\''],
  ['dynamic import', 'import(\'./required.cjs\')'],
  ['re-export', 'export { value } from \'./required.cjs\''],
])('rejects missing required oxide %s targets despite the optional fallback', (_, required) => {
  const { root, names } = fixture('@tailwindcss/oxide', `${optionalWasi}
${required}`)
  expect(() => pruneDeployment(root, names)).toThrow(`PLUGIN_DEPLOY_RELATIVE_MISSING:
  ${join('@tailwindcss/oxide', 'index.js')} -> ./required.cjs`)
})

it('rejects the same missing WASI fallback in another package', () => {
  const { root, names } = fixture('other-oxide')
  expect(() => pruneDeployment(root, names)).toThrow(`PLUGIN_DEPLOY_RELATIVE_MISSING:
  ${join('other-oxide', 'index.js')} -> ./tailwindcss-oxide.wasi.cjs`)
})

it('rejects the missing WASI fallback outside the oxide root entry', () => {
  const { root, names } = fixture('@tailwindcss/oxide', optionalWasi, 'lib/index.js')
  expect(() => pruneDeployment(root, names)).toThrow(`PLUGIN_DEPLOY_RELATIVE_MISSING:
  ${join('@tailwindcss/oxide', 'lib/index.js')} -> ./tailwindcss-oxide.wasi.cjs`)
})

it.each([
  ['static import', 'import value from \'./tailwindcss-oxide.wasi.cjs\''],
  ['dynamic import', 'import(\'./tailwindcss-oxide.wasi.cjs\')'],
  ['re-export', 'export { value } from \'./tailwindcss-oxide.wasi.cjs\''],
])('rejects a required oxide %s even when it uses the optional WASI filename', (_, source) => {
  const { root, names } = fixture('@tailwindcss/oxide', source)
  expect(() => pruneDeployment(root, names)).toThrow(`PLUGIN_DEPLOY_RELATIVE_MISSING:
  ${join('@tailwindcss/oxide', 'index.js')} -> ./tailwindcss-oxide.wasi.cjs`)
})

// 远端矩阵只有 glibc 绑定；musl 绑定不在其中，且会让 Linux 上的 linuxdeploy 崩溃。
const REMOTE_MATRIX = ['linux-x64-gnu', 'linux-arm64-gnu', 'darwin-x64']
const MUSL = ['linux-x64-musl', 'linux-arm64-musl']

it('accepts a deploy tree that carries every binding the remote matrix needs', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-deploy-native-'))
  roots.push(root)
  for (const name of REMOTE_MATRIX) {
    const dir = join(root, '@tailwindcss', `oxide-${name}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `tailwindcss-oxide.${name}.node`), '')
  }
  expect(() => verifyRemoteNativeBindings(root)).not.toThrow()
})

it('removes musl bindings so linuxdeploy cannot choke on them during AppImage bundling', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-deploy-native-'))
  roots.push(root)
  for (const name of ['linux-x64-gnu', 'linux-arm64-gnu', 'linux-x64-musl', 'linux-arm64-musl']) {
    const dir = join(root, '@tailwindcss', `oxide-${name}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `tailwindcss-oxide.${name}.node`), '')
  }
  pruneForeignLibcBindings(root)
  expect(existsSync(join(root, '@tailwindcss', 'oxide-linux-x64-musl'))).toBe(false)
  expect(existsSync(join(root, '@tailwindcss', 'oxide-linux-arm64-musl'))).toBe(false)
  expect(existsSync(join(root, '@tailwindcss', 'oxide-linux-x64-gnu'))).toBe(true)
  expect(existsSync(join(root, '@tailwindcss', 'oxide-linux-arm64-gnu'))).toBe(true)
})

it('tolerates musl bindings in the tree, they are not part of the remote matrix', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-deploy-native-'))
  roots.push(root)
  for (const name of [...REMOTE_MATRIX, ...MUSL]) {
    const dir = join(root, '@tailwindcss', `oxide-${name}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `tailwindcss-oxide.${name}.node`), '')
  }
  expect(() => verifyRemoteNativeBindings(root)).not.toThrow()
})

it.each([
  ['a missing platform package', 'linux-x64-gnu', false],
  ['a platform package shipped without its native addon', 'linux-arm64-gnu', true],
])('rejects %s so a Windows build cannot ship bindings the remote cannot load', (_, omit, withAddon) => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-deploy-native-'))
  roots.push(root)
  for (const name of REMOTE_MATRIX) {
    const dir = join(root, '@tailwindcss', `oxide-${name}`)
    if (name === omit && !withAddon)
      continue
    mkdirSync(dir, { recursive: true })
    if (name !== omit)
      writeFileSync(join(dir, `tailwindcss-oxide.${name}.node`), '')
  }
  expect(() => verifyRemoteNativeBindings(root)).toThrow(`PLUGIN_DEPLOY_NATIVE_MISSING:
  @tailwindcss/oxide-${omit}`)
})
