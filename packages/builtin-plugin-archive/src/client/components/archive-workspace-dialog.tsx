import type { ArchiveWorkspaceDialogProps } from './archive-panel.types'
import { Button, Modal } from 'dsh-tauri-ui/client'
import { locale } from '../locales'

export function ArchiveWorkspaceDialog(props: ArchiveWorkspaceDialogProps) {
  return (
    <Modal
      open
      onClose={props.onClose}
      title={locale.text('archiveWorkspaceTitle', { count: props.sessionIds.length })}
      description={locale.text('archiveWorkspaceDescription', { workspace: props.workspaceTitle })}
      closeLabel={locale.text('close')}
      footer={(
        <>
          <Button variant="ghost" onClick={props.onClose} style={{ marginRight: 6 }}>{locale.text('cancel')}</Button>
          <Button variant="outline" onClick={props.onConfirm}>{locale.text('archiveWorkspaceConfirm')}</Button>
        </>
      )}
    />
  )
}
