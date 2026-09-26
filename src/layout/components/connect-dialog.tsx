import { Button, Description, Modal, Spinner } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { cn } from 'tailwind-variants'
import { useStore } from 'valtio-define'
import { Logs } from '@/components/logs'
import { store } from '@/store'

/**
 * 连接进度弹窗：点击未连接机器后实时呈现管线进度。
 *
 * 内容：阶段步骤条（只显示真实走过的阶段，当前阶段高亮）+ machine.events
 * 实时日志尾。成功即自动关闭（pendingId 清空）；失败定格：直接原因 +
 * 已走阶段 + 日志全部保留，提供「重试 / 关闭」。进行中可关闭弹窗，
 * 连接在后台继续（不影响引擎侧）。
 */
export function ConnectDialog() {
  const { t } = useTranslation()
  const { machines, pendingId, connectFailed, connectTrail, connectLog, connectDismissed } = useStore(store.remote)

  const targetId = pendingId ?? connectFailed?.id ?? null
  const machine = targetId === null ? undefined : machines.find(item => item.id === targetId)
  // 进行中手动关过则隐藏到落定；失败定格始终可见
  const isOpen = connectFailed !== null || (pendingId !== null && !connectDismissed)
  const failed = connectFailed !== null
  // 当前阶段：列表行的 live progress（落定即消失，trail 最后一项兜底）
  const currentPhase = machine?.progress?.phase ?? (failed ? undefined : connectTrail[connectTrail.length - 1])

  function handleRetry() {
    if (connectFailed === null)
      return
    store.remote.dismissConnect()
    store.remote.switchTo(connectFailed.id)
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open: boolean) => {
        if (!open)
          store.remote.dismissConnect()
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header className="mb-2">
              <Modal.Heading>
                {failed ? t('remote.connect.failed_title') : t('remote.connect.title', { name: machine?.name ?? '' })}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="space-y-3">
              {/* 阶段步骤条：仅真实走过的阶段 */}
              <If cond={connectTrail.length > 0 || currentPhase !== undefined}>
                <div className="flex items-center gap-1.5" data-testid="connect-steps">
                  {(connectTrail.length > 0 ? connectTrail : currentPhase !== undefined ? [currentPhase] : []).map((phase, index, all) => (
                    <span
                      // 阶段可能重复出现（重试），以序位区分 key
                      // eslint-disable-next-line react/no-array-index-key
                      key={`${phase}-${index}`}
                      className={cn(
                        'rounded-md px-2 py-0.5 text-xs',
                        index === all.length - 1 && !failed ? 'bg-accent/10 text-accent' : 'bg-panel2 text-muted',
                      )}
                    >
                      {t(`remote.step.${phase}`)}
                    </span>
                  ))}
                </div>
              </If>
              <If cond={failed}>
                <Description className="text-danger break-all">{connectFailed?.error}</Description>
              </If>
              <Logs logs={connectLog} bodyClassName="max-h-[160px]" />
              <If cond={!failed}>
                <Description className="flex items-center gap-1.5">
                  <Spinner className="size-3" />
                  {t('remote.connect.working')}
                </Description>
              </If>
            </Modal.Body>
            <Modal.Footer>
              <If cond={failed}>
                <Button className="rounded-md" variant="tertiary" onPress={() => store.remote.dismissConnect()}>
                  {t('buttons.close')}
                </Button>
                <Button className="rounded-md" variant="primary" onPress={handleRetry}>
                  {t('remote.connect.retry')}
                </Button>
              </If>
              <If cond={!failed}>
                <Button className="rounded-md" variant="tertiary" onPress={() => store.remote.dismissConnect()}>
                  {t('buttons.close')}
                </Button>
                <Button
                  className="rounded-md"
                  variant="secondary"
                  data-testid="connect-cancel"
                  onPress={() => pendingId !== null && store.remote.cancelConnect(pendingId)}
                >
                  {t('remote.connect.cancel')}
                </Button>
              </If>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
