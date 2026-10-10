import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import { Button, Icon, Modal, Toast, TriangleExclamation } from 'dsh-tauri-ui/client'
import { useStore } from 'dsh-tauri/client'
import { cancelTaskDeletion, confirmTaskDeletion, dismissDeletionFeedback } from '../service/deletion'
import { store } from '../store'

export function ScheduleDeletionOverlay({ t }: { t: Translate }): ReactElement {
  const { pendingTask, deletingTaskId, feedback } = useStore(store.deletion)
  const navigation = useStore(store.navigation)
  const deleting = deletingTaskId !== null
  const close = () => cancelTaskDeletion()
  return (
    <>
      <Modal
        open={pendingTask !== null}
        onClose={close}
        title={t('deleteConfirmTitle')}
        description={t('deleteConfirmBody')}
        closeLabel={t('close')}
        footer={(
          <>
            <Button disabled={deleting} onClick={close}>{t('cancel')}</Button>
            <Button variant="danger" disabled={deleting} onClick={() => void confirmTaskDeletion()}>
              {t('deleteConfirmAction')}
            </Button>
          </>
        )}
      >
        <p className="m-0 break-words text-secondary">{pendingTask?.name}</p>
        {deleting && <p role="status" className="text-tertiary">{t('deletion.pending', { name: pendingTask?.name ?? '' })}</p>}
      </Modal>
      {navigation.error && (
        <Toast
          key={`schedule-navigation-${navigation.seq}`}
          icon={<Icon as={TriangleExclamation} size={16} aria-hidden="true" />}
          text={navigation.error}
          onDone={() => {
            if (store.navigation.seq === navigation.seq)
              store.navigation.dismiss()
          }}
        />
      )}
      {feedback !== null && (
        <Toast
          key={`schedule-delete-${feedback.seq}`}
          tone={feedback.kind === 'deleted' ? 'success' : undefined}
          icon={feedback.kind === 'deleteFailed' ? <Icon as={TriangleExclamation} size={16} aria-hidden="true" /> : undefined}
          text={feedback.kind === 'deleted'
            ? t('deletion.deleted', { name: feedback.name })
            : `${t('deletion.failed', { name: feedback.name })}${feedback.error ? `: ${feedback.error}` : ''}`}
          onDone={() => dismissDeletionFeedback(feedback.seq)}
        />
      )}
    </>
  )
}
