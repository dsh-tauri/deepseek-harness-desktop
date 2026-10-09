import type { PropsWithOverlays } from '@overlastic/react'
import { AlertDialog, Button, Description, ProgressBar } from '@heroui/react'
import { useDisclosure } from '@overlastic/react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { Info } from '@/components/info'
import { store } from '@/store'

export interface DesktopUpdateDialogProps extends PropsWithOverlays {}

/** 「检查更新」对话框：展示新版本信息、下载进度并交给系统安装器。 */
export function DesktopUpdateDialog(props: DesktopUpdateDialogProps) {
  // 1. 数据查询 (Queries)
  const disclosure = useDisclosure({ props })
  const { t } = useTranslation()
  const { updateInfo, downloading, downloadProgress } = useStore(store.desktopUpdater)

  // 5. 使用 useMutation 封装安装流程 (Mutations)
  const { mutate: handlePrimary, isPending: openingInstaller } = useMutation({
    mutationFn: () => store.desktopUpdater.downloadAndOpen(),
    onSuccess: (opened) => {
      if (opened)
        disclosure.cancel()
    },
  })

  return (
    <AlertDialog onOpenChange={disclosure.cancel} isOpen={disclosure.visible}>
      <AlertDialog.Backdrop>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[420px]">
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status="default" />
              <AlertDialog.Heading>{t('update.desktop_title')}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body className="space-y-3">
              <If cond={updateInfo != null}>
                <div className="space-y-1.5">
                  <Info term={t('ui.current_version')}>{updateInfo?.currentVersion}</Info>
                  <Info term={t('update.new_version_label')}>{updateInfo?.version}</Info>
                  <If cond={updateInfo?.downloaded}>
                    <Description className="text-xs">
                      {t('update.desktop_downloaded')}
                    </Description>
                  </If>
                </div>
              </If>

              <If cond={downloading}>
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted">
                    <span>{t('update.desktop_downloading')}</span>
                    <span className="shrink-0">
                      {Math.round(downloadProgress)}
                      %
                    </span>
                  </div>
                  <ProgressBar value={downloadProgress} className="w-full">
                    <ProgressBar.Track>
                      <ProgressBar.Fill className="bg-info" />
                    </ProgressBar.Track>
                  </ProgressBar>
                </div>
              </If>
            </AlertDialog.Body>
            <If cond={!downloading}>
              <AlertDialog.Footer>
                <Button
                  variant="tertiary"
                  onPress={disclosure.cancel}
                >
                  {t('update.later')}
                </Button>
                <Button
                  variant="primary"
                  isDisabled={updateInfo == null || openingInstaller}
                  onPress={() => handlePrimary()}
                >
                  {updateInfo?.downloaded
                    ? t('update.open_installer')
                    : t('update.now')}
                </Button>
              </AlertDialog.Footer>
            </If>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  )
}
