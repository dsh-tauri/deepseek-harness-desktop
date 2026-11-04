import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { applyBundleManifest, readBuildConstants, readBundleDshVersion, readManifest } from './bundle-metadata.mjs'

vi.mock('../packages/builtin-plugin-remote/src/host/service/gateway.auth.ts', () => ({ gatewayAuthHtml: async () => '' }))

it('loads remote build engine definitions from the repository manifest without building plugins', async () => {
  const { default: configure } = await import('../packages/builtin-plugin-remote/tsdown.config.ts')
  const [server] = await configure()
  const { dsh } = readManifest(fileURLToPath(new URL('../', import.meta.url))).engines
  expect(server.define.__REMOTE_DSH_MINIMUM__).toBe(JSON.stringify(dsh.minimum))
})

it('reads bundle metadata and rewrites bundled roots in the desktop workspace', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'bundle-metadata-'))
  try {
    const desktop = path.join(repo, 'apps/desktop/src-tauri')
    mkdirSync(path.join(desktop, 'resources'), { recursive: true })
    mkdirSync(path.join(desktop, 'src/config'), { recursive: true })
    const file = path.join(desktop, 'resources/manifest.jsonc')
    writeFileSync(file, JSON.stringify({
      engines: { dsh: { bundle: '0.2.1-rc.5' } },
      dependencies: { node: {}, pnpm: {}, dsh: {}, git: { managedRoot: 'unchanged' } },
    }))
    const constants = ['NODE_VERSION', 'NODE_BASE_URL', 'PNPM_VERSION', 'PNPM_BASE_URL', 'PNPM_SHA256', 'MINGIT_VERSION', 'MINGIT_BASE_URL', 'MINGIT_X64_SHA256', 'MINGIT_ARM64_SHA256', 'DSH_CORE_URL']
    writeFileSync(path.join(desktop, 'src/config/constants.rs'), constants.map(name => `pub const ${name}: &str = "${name}";`).join('\n'))

    expect(readBundleDshVersion(repo)).toBe('0.2.1-rc.5')
    expect(readBuildConstants(repo)).toMatchObject({ nodeVersion: 'NODE_VERSION', pnpmSha256: 'PNPM_SHA256', dshCoreUrl: 'DSH_CORE_URL' })
    expect(applyBundleManifest({ repo, platform: 'windows' }).file).toBe(file)
    expect(JSON.parse(readFileSync(file, 'utf8')).dependencies).toEqual({
      node: { managedRoot: '$Resources/node', overridable: false },
      pnpm: { managedRoot: '$Resources/pnpm', overridable: false },
      dsh: { managedRoot: '$Resources/dsh', overridable: true },
      git: { managedRoot: 'unchanged' },
    })
  }
  finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
