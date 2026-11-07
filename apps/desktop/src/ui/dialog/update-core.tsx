import type { PropsWithOverlays } from '@overlastic/react'
import type { InstallProgress } from '@/store/modules/harness'
import type { HarnessCore } from '@/types'
import { AlertDialog, Button, Spinner } from '@heroui/react'
import { useDisclosure } from '@overlastic/react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { Panel } from '@/components/panel'
import { useListen } from '@/hooks/use-listen'

/**
 * 核心版本下载对话框：复用首次安装（setup）的 `install-progress` 事件流，
 * 以进度条 + 日志面板展示下载/解压过程；成功自动关闭，失败展示错误与日志。
 *
 * 用法（overlays provider）：
 * ```tsx
 * const openDownload = useOverlay(DownloadCoreDialog)
 * await openDownload({ tag, version, runDownload: (tag) => download.mutateAsync(tag) })
 * ```
 * `runDownload` 由调用方注入（「核心」面板的 download mutation），对话框负责
 * 监听进度事件并在结束后 resolve/reject。
 */
export interface DownloadCoreDialogProps extends PropsWithOverlays {
  /** 要下载的 release tag（如 `dsh-0.1.0-rc.8-32331963388`） */
  tag: string
  /** 展示用版本号 */
  version: string
  /** 实际下载动作（返回下载后的核心行；成功与否决定对话框如何关闭） */
  runDownload: (tag: string) => Promise<HarnessCore>
}

export function DownloadCoreDialog(props: DownloadCoreDialogProps) {
  const disclosure = useDisclosure({ props, delay: 300 })

  const { t } = useTranslation()
  const [percentage, setPercentage] = useState(0)
  const [logs, setLogs] = useState<string[]>([])
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const error = errorMsg != null

  // 进度事件：下载/解压阶段由后端 `install-progress` 推送；对话框随 provider 挂载，
  // 仅在打开期存在，因此按组件生命周期订阅即可（卸载自动注销）。
  useListen<InstallProgress>('install-progress', (event) => {
    const payload = event.payload
    // 只前进不后退（下载阶段 0-50，解压阶段 50-100，事件可能乱序到达）
    setPercentage(prev => Math.max(prev, payload.percentage))
    if (payload.log) {
      setLogs(prev => [...prev, payload.log].slice(-5))
    }
  })

  // 打开后执行下载，成功 → confirm() 关闭并 resolve，失败 → 展示错误 + 关闭按钮。
  // 需要在下一次打开/卸载时取消回调，因此保留带清理的 effect。
  useEffect(() => {
    if (!disclosure.visible) {
      return
    }
    let cancelled = false

    props.runDownload(props.tag)
      .then(() => {
        if (!cancelled) {
          disclosure.confirm()
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
                {error ? t('core.download_failed') : t('core.downloading', { version: props.version })}
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <If
                cond={!error}
                else={(
                  <div className="flex flex-col gap-3">
                    <p className="break-all font-mono text-xs leading-[1.7] text-danger">{errorMsg}</p>
                    <Panel.Progress logs={logs} />
                  </div>
                )}
              >
                <div className="flex flex-col items-start gap-3">
                  <div className="flex items-center gap-2">
                    <Spinner size="sm" color="current" />
                    <span className="text-xs text-muted">{t('core.downloading_hint', { version: props.version })}</span>
                  </div>
                  <Panel.Progress percentage={percentage} logs={logs} />
                </div>
              </If>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <If cond={error}>
                <Button variant="tertiary" onPress={disclosure.cancel}>
                  {t('core.download_close')}
                </Button>
              </If>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  )
}
