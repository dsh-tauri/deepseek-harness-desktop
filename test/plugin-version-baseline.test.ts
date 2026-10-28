import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { satisfies } from 'semver'
import { describe, expect, it } from 'vitest'

interface WorkspaceManifest {
  name: string
  dsh?: object
  engines?: { dsh?: string }
}

const packagesUrl = new URL('../packages/', import.meta.url)
const packages = readdirSync(packagesUrl, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'archive')
  .filter(entry => existsSync(new URL(`${entry.name}/package.json`, packagesUrl)))
  .map((entry) => {
    const manifest = JSON.parse(readFileSync(new URL(`${entry.name}/package.json`, packagesUrl), 'utf8')) as WorkspaceManifest
    return { directory: entry.name, manifest }
  })
const plugins = packages.filter(({ manifest }) => manifest.dsh !== undefined)

const expectedPlugins = [
  'dsh-tauri',
  'dsh-tauri-archive',
  'dsh-tauri-experimental',
  'dsh-tauri-extension',
  'dsh-tauri-mobile-ui',
  'dsh-tauri-model',
  'dsh-tauri-notification',
  'dsh-tauri-pet',
  'dsh-tauri-remote',
  'dsh-tauri-rightclick',
  'dsh-tauri-scheduler',
  'dsh-tauri-ui',
  'dsh-tauri-ui-playground',
  'dsh-tauri-worktree',
]

describe('运行插件最低内核声明', () => {
  it('覆盖全部 14 个 dsh 插件而不包含聚合与构建包', () => {
    expect(plugins.map(({ directory }) => directory).sort()).toEqual(expectedPlugins)
  })

  it.each(plugins)('$directory 明确声明最低内核为 0.2.1-rc.4', ({ manifest }) => {
    expect(manifest.engines?.dsh).toBe('>=0.2.1-rc.4')
  })

  describe.each(plugins)('$directory 的内核版本准入', ({ manifest }) => {
    it.each([
      ['0.2.1-rc.4', true],
      ['0.2.1-rc.5', true],
      ['0.2.1', true],
      ['0.2.2-alpha.2', true],
      ['0.2.1-rc.3', false],
      ['0.2.1-rc.2', false],
      ['0.1.7-rc.1', false],
      ['0.1.6', false],
    ] as const)('%s 的准入结果为 %s', (version, expected) => {
      const range = manifest.engines?.dsh
      if (typeof range !== 'string')
        throw new TypeError(`${manifest.name}: 缺少 engines.dsh 声明`)
      expect(satisfies(version, range, { includePrerelease: true })).toBe(expected)
    })
  })
})
