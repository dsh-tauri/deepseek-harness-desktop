import type { PropsWithOverlays } from '@overlastic/react'
import type { InstallProgress } from '@/store/modules/harness'
import type { CoreImportPlan } from '@/types'
import { AlertDialog, Button, Spinner } from '@heroui/react'
import { useDisclosure } from '@overlastic/react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { Panel } from '@/components/panel'
import { useListen } from '@/hooks/use-listen'

/**
 * 本地安装包导入对话框（issue #138）：复用首次安装的 `install-progress` 事件流，
 * 展示解压进度与日志；成功自动关闭，失败展示错误与日志。
 *
 * 用法（overlastic holder）：
 * ```tsx
 * const [dialog, openImport] = useOverlay(ImportCoreDialog, { type: 'holder' })
 * await openImport({ path, runImport: (path) => importCore.mutateAsync(path) })
 * ```
 * `runImport` 由调用方注入（启动页的 import mutation），对话框只负责订阅进度事件
 * 并在结束后 resolve/reject。
 */
export interface ImportCoreDialogProps extends PropsWithOverlays {
  /** 用户选中的安装包路径（如 `D:/downloads/deepseek-harness-pkg-windows.zip`） */
  path: string
  /** 实际导入动作（返回导入结果；成功与否决定对话框如何关闭） */
  runImport: (path: string) => Promise<CoreImportPlan>
}

export function ImportCoreDialog(props: ImportCoreDialogProps) {
  const disclosure = useDisclosure({ props, delay: 300 })

  const { t } = useTranslation()
  const [percentage, setPercentage] = useState(0)
  const [logs, setLogs] = useState<string[]>([])
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const error = errorMsg != null

  // 进度事件：解压阶段由后端 `install-progress` 推送；对话框随 holder 挂载，
  // 仅在打开期存在，因此按组件生命周期订阅即可（卸载自动注销）。
  useListen<InstallProgress>('install-progress', (event) => {
    const payload = event.payload
    // 只前进不后退（事件可能乱序到达）
    setPercentage(prev => Math.max(prev, payload.percentage))
    if (payload.log) {
      setLogs(prev => [...prev, payload.log].slice(-5))
    }
  })

  // 打开后执行导入，成功 → confirm() 关闭并 resolve，失败 → 展示错误 + 关闭按钮。
  // 需要在下一次打开/卸载时取消回调，因此保留带清理的 effect。
  useEffect(() => {
    if (!disclosure.visible) {
      return
    }
    let cancelled = false

    props.runImport(props.path)
      .then((plan) => {
        if (!cancelled) {
          // 导入结果要带回调用方（离线导入没有官方摘要，提示文案不同）
          disclosure.confirm(plan)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorMsg(String(err))
        }
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react/exhaustive-deps -- 仅打开时执行一次
  }, [disclosure.visible])

  const status = error ? 'danger' : 'default'
  // 只展示文件名：完整路径可能很长，且文件名本身已能区分是哪个安装包
  const fileName = props.path.split(/[\\/]/).pop() ?? props.path

  return (
    <AlertDialog onOpenChange={disclosure.cancel} isOpen={disclosure.visible}>
      <AlertDialog.Backdrop>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[420px]">
            <If cond={error}>
              <AlertDialog.CloseTrigger />
            </If>
            <AlertDialog.Header>
              <AlertDialog.Icon status={status} />
              <AlertDialog.Heading>
                {error ? t('core.import_failed') : t('core.importing')}
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <If
                cond={!error}
                else={(
                  <div className="flex flex-col gap-3">
                    <p className="break-all font-mono text-xs leading-[1.7] text-danger">{errorMsg}</p>
                    <p className="m-0 break-all font-mono text-xs leading-[1.7] text-muted">{fileName}</p>
                    <Panel.Progress logs={logs} />
                  </div>
                )}
              >
                <div className="flex flex-col items-start gap-3">
                  <div className="flex items-center gap-2">
                    <Spinner size="sm" color="current" />
                    <span className="text-xs text-muted">{t('core.importing_hint', { name: fileName })}</span>
                  </div>
                  <Panel.Progress percentage={percentage} logs={logs} />
                </div>
              </If>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <If cond={error}>
                <Button variant="tertiary" onPress={disclosure.cancel}>
                  {t('core.import_close')}
                </Button>
              </If>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  )
}
