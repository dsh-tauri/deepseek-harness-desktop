import type { ReactNode } from 'react'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { ModelsKey } from './locales.ts'
import { ChevronDown, ChevronRight, TrashBin } from 'dsh-tauri-ui/client'
import { ModelInputTypes } from './ModelInputTypes.tsx'
import { modelStyles as styles } from './styles.ts'

interface CapacityInput {
  value: string
  placeholder: string
  onChange: (value: string) => void
  onBlur?: () => void
}

interface ModelRowProps {
  model: DeepSeekModelDraft
  position: number
  inputField: 'inputModalities' | 'input'
  inputFallback?: readonly string[] | undefined
  inputLoading?: boolean
  expanded: boolean
  disabled: boolean
  t: (key: ModelsKey) => string
  contextWindow: CapacityInput
  maxTokens: CapacityInput
  onFieldChange: (field: 'id' | 'name', value: string | undefined) => void
  onIdBlur?: (value: string) => void
  onChange: (model: DeepSeekModelDraft) => void
  onToggle: () => void
  onRemove: () => void
  trailing?: ReactNode
  advanced?: ReactNode
}

export function ModelRow(props: ModelRowProps): ReactNode {
  const { model, position, t, disabled } = props
  return (
    <div className={styles.modelEntry}>
      <div className={styles.modelRow}>
        {(['id', 'name'] as const).map(field => (
          <input
            key={field}
            className={styles.input}
            type="text"
            value={typeof model[field] === 'string' ? model[field] : ''}
            placeholder={t(field === 'id' ? 'modelId' : 'modelName')}
            aria-label={`${t(field === 'id' ? 'modelId' : 'modelName')} ${String(position)}`}
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.value
              props.onFieldChange(field, field === 'name' && value === '' ? undefined : value)
            }}
            onBlur={field === 'id' ? event => props.onIdBlur?.(event.target.value) : undefined}
          />
        ))}
        {props.trailing}
        <button
          type="button"
          className={styles.iconButton}
          aria-label={`${t('modelAdvanced')} ${String(position)}`}
          aria-expanded={props.expanded}
          title={t('modelAdvanced')}
          onClick={props.onToggle}
        >
          {props.expanded ? <ChevronDown /> : <ChevronRight />}
        </button>
        <button
          type="button"
          className={`${styles.iconButton} ${styles.iconButtonDanger}`}
          aria-label={`${t('removeModel')} ${String(position)}`}
          title={t('removeModel')}
          disabled={disabled}
          onClick={props.onRemove}
        >
          <TrashBin width={14} height={14} />
        </button>
      </div>
      {props.expanded
        ? (
            <div className={styles.modelAdvanced}>
              {(['contextWindow', 'maxTokens'] as const).map(field => (
                <label className={styles.modelField} key={field}>
                  <span className={styles.modelFieldLabel}>{t(field)}</span>
                  <input
                    className={styles.input}
                    type="text"
                    inputMode="numeric"
                    value={props[field].value}
                    placeholder={props[field].placeholder}
                    aria-label={`${t(field)} ${String(position)}`}
                    disabled={disabled}
                    onChange={(event) => { props[field].onChange(event.target.value) }}
                    onBlur={props[field].onBlur}
                  />
                </label>
              ))}
              <ModelInputTypes
                model={model}
                field={props.inputField}
                position={position}
                fallback={props.inputFallback}
                disabled={disabled || props.inputLoading === true}
                t={t}
                onChange={props.onChange}
              />
              {props.advanced}
            </div>
          )
        : null}
    </div>
  )
}
