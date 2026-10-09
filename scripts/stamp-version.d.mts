/**
 * `scripts/stamp-version.mjs` 的类型声明。
 *
 * 该脚本是给 CI 直接调用的纯 ESM，本身不带类型；这里声明它导出的函数，
 * 让 `test/stamp-version.test.ts` 的导入在 `pnpm typecheck` 下可解析。
 */

export interface StampResult {
  version: string
  files: string[]
}

export function stampCargoToml(content: string, version: string, label: string): string

export function stampVersion(repo: string, version: string): StampResult
