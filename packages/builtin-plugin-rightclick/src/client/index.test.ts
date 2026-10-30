import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from './index'

// 包根的装配面在 node 下无法求值：dsh-tauri/client 是 ModuleLoader 工厂产物，
// 右键特征又会拉到 react-dom/client。这里只关心服务依赖与 effect 装配，故把
// 两侧都换成最小形状（vitest 会把 vi.mock 提升到 import 之前，位置在此安全）。
vi.mock('dsh-tauri/client', () => ({
  defineLocale: () => ({ registerLocale: () => () => {}, text: (key: string) => key }),
}))

vi.mock('./register/context-menu', () => ({
  contextMenuFeature: () => () => {},
}))

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface PackageManifest {
  dsh?: { client?: { inject?: unknown } }
}

describe('rightclick client plugin', () => {
  it('declares uiWorkspace so apply waits for the workspace service (issue #780)', () => {
    expect(inject).toEqual(['locale', 'sessions', 'workspaces', 'uiWorkspace'])
  })

  it('lists the workspace package among the dsh.client inject edges', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as PackageManifest
    expect(manifest.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-workspace')
  })

  it('registers the locale and context-menu effects on activation', () => {
    const effect = vi.fn()
    apply({ effect } as unknown as Parameters<typeof apply>[0])
    expect(effect).toHaveBeenCalledTimes(2)
    expect(effect).toHaveBeenCalledWith(expect.any(Function), 'dsh-tauri-rightclick: locale')
    expect(effect).toHaveBeenCalledWith(expect.any(Function), 'dsh-tauri-rightclick: context menu')
  })
})
