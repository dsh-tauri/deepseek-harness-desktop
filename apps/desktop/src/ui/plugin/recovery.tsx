import { CircleExclamation } from '@gravity-ui/icons'
import { Button, Chip, Description, Spinner } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { store } from '@/store'

/** 失败原因 → i18n 键映射（title / detail，detail 用 {{detail}} 插值） */
const REASON_KEYS: Record<string, { title: string, detail: string }> = {
  duplicate_route: { title: 'recovery.reason.duplicate_route.title', detail: 'recovery.reason.duplicate_route.detail' },
  duplicate_loader_entry: { title: 'recovery.reason.duplicate_loader_entry.title', detail: 'recovery.reason.duplicate_loader_entry.detail' },
  cannot_resolve_bundle: { title: 'recovery.reason.cannot_resolve_bundle.title', detail: 'recovery.reason.cannot_resolve_bundle.detail' },
  no_dsh_bundle: { title: 'recovery.reason.no_dsh_bundle.title', detail: 'recovery.reason.no_dsh_bundle.detail' },
  slot_conflict: { title: 'recovery.reason.slot_conflict.title', detail: 'recovery.reason.slot_conflict.detail' },
  load_failed: { title: 'recovery.reason.load_failed.title', detail: 'recovery.reason.load_failed.detail' },
  runtime: { title: 'recovery.reason.runtime.title', detail: 'recovery.reason.runtime.detail' },
  unknown: { title: 'recovery.reason.unknown.title', detail: 'recovery.reason.unknown.detail' },
}

/**
 * 插件异常修复界面。
 *
 * - 启动崩溃（`fullScreen`）：渲染全屏恢复页（替换 Setup 错误内容），
 *   主按钮「卸除此插件并继续检测」。
 * - 运行期异常（应用仍在运行）：渲染醒目对话框（不阻断使用），可「暂不处理」。
 *
 * 数据全部来自 recovery store 的 `recovery` 状态（`plugin-recovery-required`
 * 事件 / 启动失败检测触发），不在组件内自行拉取。
 */
export function Recovery({ fullScreen = false }: { fullScreen?: boolean }) {
  const { t } = useTranslation()
  const { recovery, exhausted } = useStore(store.recovery)

  if (!recovery.required || !recovery.info) {
    return null
  }

  const info = recovery.info
  const multiple = info.plugins.length > 1
  const reasonKeys = REASON_KEYS[info.reason] ?? REASON_KEYS.unknown
  const heading = multiple
    ? t('recovery.heading_many', { count: info.plugins.length })
    : t('recovery.heading_one')
  const primaryLabel = multiple
    ? t('recovery.remove_many', { count: info.plugins.length })
    : t('recovery.remove_one')
  const reasonDetail = info.detail
    ? t(reasonKeys.detail, { detail: info.detail })
    : t(reasonKeys.detail)

  return (
    <div
      className={fullScreen
        ? 'flex h-full w-full items-center justify-center overflow-auto bg-startup p-6'
        : 'fixed inset-0 z-50 flex items-center justify-center bg-backdrop p-4'}
    >
      <div className={`w-full ${fullScreen ? 'max-w-[640px]' : 'max-w-[560px]'}`}>
        {/* 运行期弹窗必须是**不透明**面板：`bg-panel2/40` 只有 40% 不透明度，页面内容会直接
            透出来（表现为「弹窗透明、与页面内容重叠」）；全屏恢复页底下是与 navbar 同 alpha
            的启动底色，半透明面板才是想要的层次感，故只在非 fullScreen 分支换成实心 `bg-panel`。 */}
        <div className={fullScreen
          ? 'rounded-xl border border-line bg-panel2/40 p-6'
          : 'rounded-xl border border-line bg-panel p-6 shadow-lg'}
        >
          <div className="mb-4 flex items-center gap-3">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
              <CircleExclamation className="size-6" />
            </div>
            <div className="min-w-0">
              <p className="m-0 text-base font-semibold text-ink">{heading}</p>
              <p className="m-0 text-xs text-muted">{t(reasonKeys.title)}</p>
            </div>
          </div>

          <Description className="mb-3 text-sm text-ink">
            {reasonDetail}
          </Description>

          <div className="mb-3 space-y-1.5">
            {info.plugins.map(pkg => (
              <div key={pkg} className="flex items-center justify-between gap-2 rounded-md bg-black/5 px-3 py-2">
                <code className="min-w-0 truncate font-mono text-sm text-ink">{pkg}</code>
                <Chip className="shrink-0 text-xs" variant="primary" color="danger" size="sm">
                  {t('recovery.offender')}
                </Chip>
              </div>
            ))}
          </div>

          <If cond={exhausted}>
            <p className="m-0 mb-3 text-xs text-warning">{t('recovery.summary_exhausted')}</p>
          </If>

          <p className="m-0 mb-4 text-xs text-load-muted">{t('recovery.safety_note')}</p>

          {/* 错误信息默认展示（含原始错误，便于排查） */}
          <div className="mb-4 max-h-48 overflow-auto rounded-md bg-black/5 p-3">
            <pre className="m-0 whitespace-pre-wrap break-all font-mono text-[11px] text-muted">
              {info.rawError || '—'}
            </pre>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="danger"
              onPress={() => store.recovery.recoverAndRedetect(info.plugins)}
            >
              <span className="flex items-center gap-1">
                <If cond={recovery.busy} then={<Spinner size="sm" color="current" />} />
                {recovery.busy ? t('recovery.removing') : primaryLabel}
              </span>
            </Button>
            <Button variant="tertiary" onPress={() => store.harness.restart()}>
              {t('recovery.restart')}
            </Button>
            <Button variant="ghost" onPress={() => store.recovery.dismissRecovery()}>
              {t('recovery.dismiss')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
