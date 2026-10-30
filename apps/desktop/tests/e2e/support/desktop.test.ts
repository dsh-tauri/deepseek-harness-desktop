import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resetTestStore } from './desktop'

const roots: string[] = []

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('原生配置隔离清理', () => {
  it('仅删除本次 scratch 的测试 Store，保留同目录其他配置', async () => {
    const root = scratch('dsh-e2e-desktop-')
    const data = join(root, 'app-data')
    mkdirSync(data)
    const testStore = join(data, '.store.test.dat')
    const productionStore = join(data, '.store.dat')
    const developmentStore = join(data, '.store.dev.dat')
    writeFileSync(testStore, 'test')
    writeFileSync(productionStore, 'production')
    writeFileSync(developmentStore, 'development')
    await resetTestStore(root)
    expect(existsSync(testStore), '独占测试配置必须被删除').toBe(false)
    expect(readFileSync(productionStore, 'utf8'), '清理不得波及生产配置').toBe('production')
    expect(readFileSync(developmentStore, 'utf8'), '清理不得波及开发配置').toBe('development')
    await expect(resetTestStore(root), '重复清理必须安全').resolves.toBeUndefined()
  })

  it('非专用根必须拒绝，不能靠调用方路径删除配置', async () => {
    const root = scratch('dsh-store-negative-')
    const data = join(root, 'app-data')
    mkdirSync(data)
    const store = join(data, '.store.test.dat')
    writeFileSync(store, 'must survive')
    await expect(resetTestStore(root), '未标记的目录即使在 Temp 中也不能清理').rejects.toThrow('仅可使用系统临时目录')
    expect(readFileSync(store, 'utf8'), '被拒绝目录内容必须不变').toBe('must survive')
  })
})
