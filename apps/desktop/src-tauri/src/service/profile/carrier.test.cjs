const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { pathToFileURL } = require('node:url')

for (const desktopHost of [false, true]) {
  test(`carrier preserves root Include ownership through an aliased ${desktopHost ? 'desktop profile' : 'CLI'} entry`, { timeout: 10000 }, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-carrier-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const core = path.join(root, 'core')
    const alias = path.join(root, 'alias')
    function write(filename, content) {
      const target = path.join(core, filename)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }
    function packageJson(name, exports) {
      write('node_modules/@deepseek-ai/' + name + '/package.json', JSON.stringify({ name: '@deepseek-ai/' + name, type: 'module', exports }))
    }
    packageJson('dsh', { './lib/bin.js': './bin.js', './profile-boot': './boot.js', './package.json': './package.json' })
    packageJson('dsh-app-boot', './index.js')
    packageJson('dsh-home-paths', './index.js')
    write('node_modules/@deepseek-ai/dsh-app-boot/index.js', `
      const roots = new WeakMap()
      export function mount(ctx) { roots.set(ctx, 'include') }
      export function reload(ctx) {
        if (!roots.has(ctx)) throw new Error('dsh: profile reload requires the root Include entry')
        return roots.get(ctx)
      }
      export const loadLayeredEnv = () => ({})
      export const loadProfileDirectory = () => ({})
      export const reportSkippedBundles = () => {}
    `)
    write('node_modules/@deepseek-ai/dsh-home-paths/index.js', 'export const resolveDshHome = () => process.env.HOME')
    write('node_modules/@deepseek-ai/dsh/boot.js', `
      import assert from 'node:assert/strict'
      import { realpathSync } from 'node:fs'
      import { pathToFileURL, fileURLToPath } from 'node:url'
      import { mount } from '@deepseek-ai/dsh-app-boot'
      export async function runProfile() {
        const ctx = {}
        mount(ctx)
        const canonical = pathToFileURL(realpathSync.native(fileURLToPath(new URL('../dsh-app-boot/index.js', import.meta.url))))
        const { reload } = await import(canonical.href)
        assert.equal(reload(ctx), 'include')
        process.stdout.write('root Include retained')
      }
    `)
    write('node_modules/@deepseek-ai/dsh/bin.js', "export { runProfile as runCli } from './boot.js'")
    fs.symlinkSync(core, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const carrier = pathToFileURL(path.join(__dirname, 'carrier.mjs')).href
    const entry = path.join(alias, 'node_modules/@deepseek-ai/dsh/bin.js')
    const result = spawnSync(process.execPath, ['--preserve-symlinks', '--input-type=module', '--eval', `import(${JSON.stringify(carrier)}).then(m => m.main(${desktopHost}))`, entry, '--profile', 'desktop'], {
      env: { ...process.env, HOME: root }, encoding: 'utf8', timeout: 8000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'root Include retained')
  })
}
