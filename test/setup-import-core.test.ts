import { describe, expect, it } from 'vitest'
import { readLocale, readSource } from './setup/read-source'

const SETUP = 'src/layout/components/setup.tsx'
const DIALOG = 'src/ui/dialog/import-core.tsx'
const CORE_MOD = 'src-tauri/src/service/core/mod.rs'
const BUILDER = 'src-tauri/src/desktop/builder.rs'
const IMPORTER = 'src-tauri/src/service/core/importer.rs'

/** 取 `<button …>…</button>` 片段：label 所在按钮自己的 JSX（光有 import 不算） */
function buttonBlock(source: string, label: string): string {
  const index = source.indexOf(label)
  expect(index, label).toBeGreaterThan(-1)
  const open = source.lastIndexOf('<button', index)
  const close = source.indexOf('</button>', index)
  expect(open, label).toBeGreaterThan(-1)
  expect(close, label).toBeGreaterThan(index)
  return source.slice(open, close)
}

describe('local core package import (issue #138)', () => {
  it('offers the import entry on the setup error page', () => {
    const source = readSource(SETUP)
    expect(source).toContain(`invoke<string | null>('pick_core_package')`)
    expect(source).toContain(`invoke<CoreImportPlan>('import_core', { path: target })`)

    // 按钮必须落在错误态操作区（<If cond={error}> 的 <Then> 里），
    // 否则安装中/就绪态也会出现一个点了没反应的入口。
    const label = source.indexOf(`t('buttons.import_core')`)
    const errorBranch = source.indexOf('<If cond={error}>')
    const thenClose = source.indexOf('</Then>', errorBranch)
    expect(errorBranch).toBeGreaterThan(-1)
    expect(label).toBeGreaterThan(errorBranch)
    expect(label).toBeLessThan(thenClose)
  })

  it('labels the import button with the shared i18n key and icon', () => {
    const source = readSource(SETUP)
    expect(buttonBlock(source, `t('buttons.import_core')`)).toContain('<FileArrowUp')
    expect(source).toContain('hints.import_core')
    // 对话框 holder 必须渲染出来，否则导入弹窗永远不会出现
    expect(source).toContain('useOverlay<ImportCoreDialogProps, CoreImportPlan>(ImportCoreDialog, { type: \'holder\' })')
    expect(source).toContain('{importDialog}')
  })

  it('aborts the import when the picker is dismissed', () => {
    const source = readSource(SETUP)
    // 取消选择（null）必须直接返回：既不能打开对话框，也不能弹 toast
    const picked = source.indexOf(`invoke<string | null>('pick_core_package')`)
    const guard = source.slice(picked, picked + 900)
    expect(guard).toContain('if (path == null)')
    expect(guard.indexOf('if (path == null)')).toBeLessThan(guard.indexOf('openImportDialog'))
    // 选择失败（rfd 抛错）也要可见：静默 catch 会让按钮看起来毫无反应
    expect(source).toContain(`toast(t('core.import_pick_failed'), { variant: 'danger' })`)
    // 对话框必须把导入结果带回调用方，否则 setup 拿到的 plan 是 undefined
    expect(readSource(DIALOG)).toContain('disclosure.confirm(plan)')
  })

  it('restarts the startup flow after a successful import', () => {
    const source = readSource(SETUP)
    const picked = source.indexOf(`invoke<CoreImportPlan>('import_core'`)
    const after = source.slice(picked, picked + 900)
    expect(after).toContain('store.harness.boot()')
    // 离线导入拿不到官方发行摘要，必须给出与已校验导入不同的提示
    expect(after).toContain(`t('core.imported_toast', { version: plan.version })`)
    expect(after).toContain(`t('core.imported_unverified_toast', { version: plan.version })`)
    expect(after).toContain(`variant: plan.verified ? 'success' : 'warning'`)
  })

  it('streams install-progress through the import dialog', () => {
    const source = readSource(DIALOG)
    expect(source).toContain(`useListen<InstallProgress>('install-progress'`)
    expect(source).toContain('Panel.Progress')
    // 对话框只负责展示：真正的导入动作由调用方注入
    expect(source).toContain('props.runImport(props.path)')
    expect(source).toContain(`t('core.import_failed')`)
  })

  it('keeps both locales in sync for the import entry', () => {
    const zh = readLocale('zh-CN')
    const en = readLocale('en-US')
    const keys = [
      'buttons.import_core',
      'hints.import_core',
      'core.import_failed',
      'core.importing',
      'core.importing_hint',
      'core.import_close',
      'core.import_pick_failed',
      'core.imported_toast',
      'core.imported_unverified_toast',
    ]
    for (const key of keys) {
      expect(zh[key], key).toBeTruthy()
      expect(en[key], key).toBeTruthy()
    }
    // 离线提示必须点明「未校验」，否则用户无从判断安装包是否可信
    expect(zh['core.imported_unverified_toast']).toContain('未校验')
    expect(en['core.imported_unverified_toast']).toContain('could not be verified')
  })

  it('registers the importer commands and the service module', () => {
    const mod = readSource(CORE_MOD)
    expect(mod).toContain('mod importer;')
    expect(mod).toContain('pub use importer::{import_local_package, CoreImportPlan};')

    const builder = readSource(BUILDER)
    expect(builder).toContain('crate::bridge::pick_core_package')
    expect(builder).toContain('crate::bridge::import_core')
  })

  it('verifies platform, structure and official digest before activating', () => {
    const source = readSource(IMPORTER)
    // 平台不符的官方资产名要直接拒绝（下载了别的平台/架构的包）
    expect(source).toContain('CORE_IMPORT_PLATFORM_MISMATCH')
    // 结构校验：必须确认包内有核心入口，避免解压出一份切过去也起不来的槽位
    expect(source).toContain('CORE_IMPORT_NOT_A_PACKAGE')
    // 摘要反查：官方发行目录里没有该版本时按本地 tag 落地，有则必须比对成功
    expect(source).toContain('CORE_IMPORT_DIGEST_MISMATCH')
    expect(source).toContain('fetch_dsh_pkg_releases(app_handle)')
    expect(source).toContain('fetch_dsh_pkg_asset(app_handle, tag)')
    // 导入后必须写回身份：切换链路的 tag→commit 反查在断网时必然失败，
    // 不覆盖就会留下与 tag 不匹配的旧 commit，更新检查会误判滞后
    expect(source).toContain('set_dsh_pkg_identity')
    // 本地 tag 必须带 build-id 段，否则 parse_version_from_tag 会把版本截断
    expect(source).toContain('LOCAL_TAG_SUFFIX')
  })
})
