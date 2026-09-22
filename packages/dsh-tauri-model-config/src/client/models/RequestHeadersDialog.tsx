import type { ReactNode } from 'react'
import type { en } from './locales.ts'
import type { HeaderRow, RequestHeaders } from './requestHeaders.ts'
import { Button, IconPlusOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useRef, useState } from 'react'
import {
  hasUserAgentHeader,
  headerRowsOf,
  requestHeaderFailure,
  requestHeadersFromRows,
} from './requestHeaders.ts'
import { modelStyles as styles } from './styles.ts'

interface EditableRow extends HeaderRow {
  id: number
}

export interface RequestHeadersDialogProps {

  headers: RequestHeaders

  disabled: boolean

  t: (key: keyof typeof en) => string

  onClose: () => void

  onSubmit: (headers: RequestHeaders) => void
}

function IconTrash(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1 1 0 001 .9h4.6a1 1 0 001-.9L12 4M6.5 6.8v4.4M9.5 6.8v4.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function RequestHeadersDialog(props: RequestHeadersDialogProps): ReactNode {
  const { t } = props
  const nextRowIdRef = useRef(0)
  const makeRow = (name = '', value = ''): EditableRow => {
    nextRowIdRef.current += 1
    return { id: nextRowIdRef.current, name, value }
  }
  const [rows, setRows] = useState<readonly EditableRow[]>(
    () => headerRowsOf(props.headers).map(row => makeRow(row.name, row.value)),
  )
  const failure = requestHeaderFailure(rows)
  const headers = requestHeadersFromRows(rows)

  const edit = (index: number, patch: Partial<HeaderRow>): void => {
    setRows(current => current.map((row, at) => (at === index
      ? { id: row.id, name: patch.name ?? row.name, value: patch.value ?? row.value }
      : row)))
  }

  return (
    <Modal
      open
      onClose={props.onClose}
      title={t('requestHeaders')}
      closeLabel={t('close')}
      description={t('requestHeadersDescription')}
      className={styles.headersDialog as string}
      footer={(
        <>
          <Button variant="outline" disabled={props.disabled} onClick={props.onClose}>
            {t('cancel')}
          </Button>
          <Button
            disabled={props.disabled || failure !== undefined}
            onClick={() => { props.onSubmit(headers) }}
          >
            {t('confirm')}
          </Button>
        </>
      )}
    >
      <div className={styles.headersBody}>
        <div className={styles.headerRows}>
          {rows.map((row, index) => (
            <div key={row.id} className={styles.headerRow}>
              <input
                className={styles.input}
                type="text"
                value={row.name}
                placeholder={t('headerNamePlaceholder')}
                aria-label={`${t('headerName')} ${String(index + 1)}`}
                aria-invalid={failure?.index === index && failure?.key !== 'headerValueInvalid'}
                autoComplete="off"
                spellCheck={false}
                data-dsh-model-header-name=""
                disabled={props.disabled}
                onChange={(event) => { edit(index, { name: event.target.value }) }}
              />
              <input
                className={styles.input}
                type="text"
                value={row.value}
                placeholder={t('headerValuePlaceholder')}
                aria-label={`${t('headerValue')} ${String(index + 1)}`}
                aria-invalid={failure?.index === index && failure?.key === 'headerValueInvalid'}
                autoComplete="off"
                spellCheck={false}
                data-dsh-model-header-value=""
                disabled={props.disabled}
                onChange={(event) => { edit(index, { value: event.target.value }) }}
              />
              <button
                type="button"
                className={`${styles.iconButton} ${styles.iconButtonDanger}`}
                aria-label={`${t('removeHeader')} ${String(index + 1)}`}
                title={t('removeHeader')}
                data-dsh-model-header-remove=""
                disabled={props.disabled || rows.length === 1}
                onClick={() => { setRows(current => current.filter((_row, at) => at !== index)) }}
              >
                <IconTrash />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className={styles.addModelButton}
          data-dsh-model-header-add=""
          disabled={props.disabled}
          onClick={() => { setRows(current => [...current, makeRow()]) }}
        >
          <IconPlusOutline16 size={14} />
          {t('addHeader')}
        </button>
        {failure === undefined
          ? null
          : (
              <p role="alert" className={styles.error}>
                {`${t('headerRow')} ${String(failure.index + 1)}: ${t(failure.key)}`}
              </p>
            )}
        {hasUserAgentHeader(headers) ? <p className={styles.advancedHint}>{t('headerUserAgentNotice')}</p> : null}
      </div>
    </Modal>
  )
}
