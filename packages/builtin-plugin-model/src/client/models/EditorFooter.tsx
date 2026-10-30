import type { ReactNode } from 'react'
import type { en } from './locales.ts'
import { modelStyles as styles } from './styles.ts'

export interface EditorFooterProps {
  t: (key: keyof typeof en) => string
  busy: boolean
  submitDisabled: boolean
  submitLabelKey: keyof typeof en
  submitBusyLabelKey: keyof typeof en
  cancelLabelKey?: keyof typeof en
  onCancel: () => void
  onSubmit: () => void
}

export function EditorFooter(props: EditorFooterProps): ReactNode {
  const { t } = props
  return (
    <div className={styles.editorActions}>
      <button
        type="button"
        className={styles.secondaryButton}
        disabled={props.busy}
        onClick={props.onCancel}
      >
        {t(props.cancelLabelKey ?? 'cancel')}
      </button>
      <button
        type="button"
        className={styles.primaryButton}
        disabled={props.submitDisabled}
        onClick={props.onSubmit}
      >
        {props.busy ? t(props.submitBusyLabelKey) : t(props.submitLabelKey)}
      </button>
    </div>
  )
}
