import type { PropsWithOverlays } from '@overlastic/react'
import { ArrowUpRightFromSquare } from '@gravity-ui/icons'
import { Button, Description, Modal } from '@heroui/react'
import { useDisclosure } from '@overlastic/react'
import { useWhenever } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { Info } from '@/components/info'
import { store } from '@/store'
import { silence } from '@/utils/silence'

export interface DesktopAboutDialogProps extends PropsWithOverlays {}

/**
 * 「关于 Desktop」对话框：展示 Powered by、版本号、发布时间与版权信息。
 *
 * 使用 overlastic 命令式打开（`useOverlay(DesktopAboutDialog)`），
 * 打开时通过 store 的 `loadAbout` 拉取信息，关闭由 `disclosure.cancel` 完成。
 */
export function DesktopAboutDialog(props: DesktopAboutDialogProps) {
  const disclosure = useDisclosure({ props })
  const { t } = useTranslation()
  const { about } = useStore(store.desktopUpdater)

  // 对话框可见即拉取「关于」信息（overlastic 命令式打开 → visible 由 false 翻 true）
  useWhenever(disclosure.visible, () => {
    void store.desktopUpdater.loadAbout()
  })

  return (
    <Modal isOpen={disclosure.visible} onOpenChange={disclosure.cancel}>
      <Modal.Backdrop>
        <Modal.Container size="xs">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Body className="space-y-3">
              <div className="flex flex-col items-center gap-2 pt-1 text-center">
                <img src="/favicon.svg" alt={t('about.title')} className="w-12 h-12 rounded-md" />

                <div className="text-base font-semibold text-ink">
                  {about?.poweredBy ?? 'DeepSeek Harness Desktop'}
                </div>
                <Description className="text-xs">
                  {t('about.powered_by')}
                </Description>
              </div>
              <div className="space-y-1.5 border-t border-line/40 pt-3">
                <Info term={t('ui.current_version')}>{about?.version ?? '-'}</Info>
                <Info term={t('about.release_date')}>{about?.publishedAt ? formatDate(about.publishedAt) : '-'}</Info>
                <div className="flex items-center justify-between text-sm border-t border-line/40 pt-2 ">
                  <span className="text-muted">{t('about.source_code')}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8"
                    onPress={() => {
                      if (about?.repo)
                        void invoke('open_external_url', { url: about.repo })
                    }}
                  >
                    {t('about.github')}
                    <ArrowUpRightFromSquare />
                  </Button>
                </div>
                <Description className="text-xs pt-2 flex justify-center text-center">
                  {about?.copyright ?? '-'}
                </Description>
              </div>

            </Modal.Body>

          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime()))
      return iso
    return d.toLocaleDateString()
  }
  catch (e) {
    silence(e, 'about dialog: date parsing failed, falling back to raw ISO')
    return iso
  }
}
