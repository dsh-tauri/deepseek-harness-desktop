import type { IconComponent } from './loadable'
import type { SetupStatus } from '@/store/modules/harness'
import type { CoreImportPlan } from '@/types'
import type { ImportCoreDialogProps } from '@/ui/dialog/import-core'
import { ArrowRightFromSquare, CircleCheck, CircleExclamation, CircleInfo, Copy, FileArrowUp, Magnifier, Rocket, ShieldCheck } from '@gravity-ui/icons'
import { useOverlay } from '@overlastic/react'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { If, Then } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { button } from '@/components/primitives'
import { store } from '@/store'
import { containsPatchEntryUnresolved } from '@/store/modules/harness'
import { ImportCoreDialog } from '@/ui/dialog/import-core'
import { writeClipboardText } from '@/utils/clipboard'
import { silence } from '@/utils/silence'
import { toast } from '@/utils/toast'
import { Loadable } from './loadable'

// 各阶段对应不同图标，保持与 logo 一致的黑白中性色调
const STATUS_ICONS: Record<SetupStatus, IconComponent> = {
  checking: Magnifier,
  installing: ArrowRightFromSquare,
  starting: Rocket,
  preinstall: CircleInfo,
  ready: CircleCheck,
  error: CircleExclamation,
}

async function copyLogsHandler(t: (key: string) => string) {
  let logs: string
  try {
    logs = await invoke<string>('read_run_logs')
  }
  catch (err) {
    // 读取失败必须可见：静默 catch 会让「复制日志」看起来毫无反应
    console.error('[Setup] failed to read logs:', err)
    toast(t('messages.logs_read_failed'), { variant: 'danger' })
    return
  }
  // 成功/失败提示由 writeClipboardText 统一给出，这里只记录日志
  await writeClipboardText(logs, t('messages.logs_copied')).catch((err) => {
    console.error('[Setup] failed to copy logs:', err)
  })
}

/**
 * 安装/更新页：基于通用 Loadable 组件渲染，
 * 视觉与官方 web shell 的 boot 加载页（AppRoot）一致。
 * 状态与重试动作直接从 harness store 读取，不再接收 props。
 */
export function Setup() {
  const { t } = useTranslation()
  const [importDialog, openImportDialog] = useOverlay<ImportCoreDialogProps, CoreImportPlan>(ImportCoreDialog, { type: 'holder' })
  const {
    status,
    installer,
    errorMsg,
    errorLogs,
    pluginConflictHint,
    inotifyLimitHint,
    patchLayerHint,
    heapOomHint,
  } = useStore(store.harness)
  const error = status === 'error'
  const installing = status === 'installing'
  const heading = error ? t('status.error') : (installer.title || t('status.installing'))
  const StatusIcon = STATUS_ICONS[status]
  // 安装中展示安装日志；错误态展示启动失败时从 dsh 服务日志读取的真实错误行。
  const logs = installing ? installer.logs : (error && errorLogs.length > 0 ? errorLogs : undefined)
  const hint = error ? (patchLayerHint || pluginConflictHint || inotifyLimitHint || heapOomHint) : undefined
  // 补丁层问题分两种，恢复动作不同：语法错误整层隔离（改名备份），悬空 insert 只
  // 剥离解析不到的条目。两者的提示共用 patchLayerHint，入口按错误特征二选一。
  const patchEntriesUnresolved = error && containsPatchEntryUnresolved(errorMsg)
  const patchLayerBroken = error && patchLayerHint !== '' && !patchEntriesUnresolved

  /**
   * 内网机访问不了 GitHub 时，用预先下载的官方安装包装配核心（issue #138）：
   * 选包 → 导入（校验摘要 + 解压 + 激活）→ 成功后重新走一遍启动流程。
   * 引擎之外的依赖（Node / pnpm / Git）仍由 `install_dependencies` 负责。
   */
  async function importCoreHandler() {
    let path: string | null
    try {
      path = await invoke<string | null>('pick_core_package')
    }
    catch (err) {
      console.error('[Setup] failed to pick the core package:', err)
      toast(t('core.import_pick_failed'), { variant: 'danger' })
      return
    }
    if (path == null) {
      return
    }
    try {
      const plan = await openImportDialog({
        path,
        runImport: (target: string) => invoke<CoreImportPlan>('import_core', { path: target }),
      })
      // 离线导入拿不到官方发行摘要，只能提示用户自行确认安装包来源
      toast(
        plan.verified ? t('core.imported_toast', { version: plan.version }) : t('core.imported_unverified_toast', { version: plan.version }),
        { variant: plan.verified ? 'success' : 'warning' },
      )
      await store.harness.boot()
    }
    catch (err) {
      // 取消（关闭对话框）不算失败；导入失败已在对话框里展示完整错误
      silence(err, 'core import: dialog cancelled or import failed')
    }
  }

  return (
    <Loadable
      icon={StatusIcon}
      title={heading}
      subtitle={error ? undefined : installer.detail || t('status.installing')}
      percentage={installing ? installer.percentage : undefined}
      logs={logs}
      errorMsg={error ? errorMsg : undefined}
      testId={error ? 'dsh-setup-error' : undefined}
    >
      {hint && (
        <p className="m-0 text-xs leading-[18px] break-all text-load-muted">{hint}</p>
      )}
      <If cond={error}>
        <Then>
          {/* 错误态操作区：重试 / 导入本地安装包 / 复制日志 / 安全模式 放同一行，避免叠罗汉 */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              className={button({ tone: 'primary', size: 'sm' })}
              onClick={() => {
                void store.harness.boot()
              }}
            >
              {t('app.retry')}
            </button>
            <If cond={patchLayerBroken}>
              <button
                className={button({ tone: 'primary', size: 'sm' })}
                onClick={() => {
                  void store.harness.quarantineBrokenPatchLayers()
                }}
              >
                {t('buttons.quarantine_patch')}
              </button>
            </If>
            <If cond={patchEntriesUnresolved}>
              <button
                className={button({ tone: 'primary', size: 'sm' })}
                onClick={() => {
                  void store.harness.stripUnresolvedPatchEntries()
                }}
              >
                {t('buttons.strip_patch_entries')}
              </button>
            </If>
            <button
              className={button({ tone: 'primary', size: 'sm' })}
              onClick={() => {
                void importCoreHandler()
              }}
            >
              <FileArrowUp className="size-4" />
              {t('buttons.import_core')}
            </button>
            <button
              className={button({ tone: 'ghost', size: 'sm' })}
              onClick={() => copyLogsHandler(t)}
            >
              <Copy className="size-4" />
              {t('buttons.copy_logs')}
            </button>
            <button
              className={button({ tone: 'primary', size: 'sm' })}
              onClick={() => {
                void store.harness.enterSafeMode()
              }}
            >
              <ShieldCheck className="size-4" />
              {t('buttons.safe_mode')}
            </button>
          </div>
          <p className="m-0 text-xs leading-[18px] break-all text-load-muted">
            {t('hints.safe_mode')}
          </p>
          <p className="m-0 text-xs leading-[18px] break-all text-load-muted">
            {t('hints.import_core')}
          </p>
        </Then>
      </If>
      {importDialog}
    </Loadable>
  )
}
