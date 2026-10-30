/**
 * host/test-utils.ts — 测试专用：临时 `DSH_HOME`。
 *
 * `DSH_HOME` 是 dsh-tauri 的模块级常量（导入即求值一次），运行期无法修改；测试唯一的
 * 注入点是 `vi.mock('dsh-tauri')`：
 *
 * ```ts
 * vi.mock('dsh-tauri', async (importOriginal) => {
 *   const actual = await importOriginal<typeof import('dsh-tauri')>()
 *   const { testDshHome: home } = await import('../test-utils')
 *   return { ...actual, DSH_HOME: home }
 * })
 * ```
 *
 * `testDshHome` 在模块首次求值时创建，同一测试文件内的所有导入者共享同一个临时根，
 * 因此用例间要用 `resetTestDshHome()` 清空插件自有目录。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 本测试文件共享的临时数据根（`DSH_HOME` 替身）。 */
export const testDshHome = mkdtempSync(join(tmpdir(), 'dsh-test-home-'))

/** 清空临时数据根下的插件自有目录，让每个用例从干净状态开始。 */
export function resetTestDshHome(): void {
  for (const dir of ['ledger', 'checkout-context', 'worktrees', '.trash', 'sessions']) {
    rmSync(join(testDshHome, dir), { recursive: true, force: true })
  }
}
