import type { ReactNode } from 'react'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { ModelsKey } from './locales.ts'
import { Checkbox } from 'dsh-tauri-ui/client'
import { modelStyles as styles } from './styles.ts'

interface ModelInputTypesProps {
  model: DeepSeekModelDraft
  field: 'inputModalities' | 'input'
  position: number
  disabled: boolean
  fallback?: readonly string[] | undefined
  t: (key: ModelsKey) => string
  onChange: (model: DeepSeekModelDraft) => void
}

export function ModelInputTypes({ model, field, position, disabled, fallback, t, onChange }: ModelInputTypesProps): ReactNode {
  const modalities = model[field]
  const selected = Array.isArray(modalities) && modalities.length > 0 ? modalities : fallback ?? ['text']
  return (
    <fieldset className={styles.modelInputTypes} aria-label={`${t('modelInputTypes')} ${String(position)}`}>
      <legend className={styles.modelFieldLabel}>{t('modelInputTypes')}</legend>
      <div className={styles.modelInputChoices}>
        {(['text', 'image'] as const).map(modality => (
          <Checkbox
            key={modality}
            aria-label={t(modality === 'text' ? 'modelInputText' : 'modelInputImage')}
            checked={selected.includes(modality)}
            disabled={disabled || (selected.length === 1 && selected.includes(modality))}
            onChange={(checked) => {
              const nextSelected = (['text', 'image'] as const).filter(value =>
                value === modality ? checked : selected.includes(value))
              const next = { ...model, [field]: nextSelected }
              if (field === 'inputModalities' && !nextSelected.includes('image')) {
                Reflect.deleteProperty(next, 'imagePixelBudget')
                Reflect.deleteProperty(next, 'imageMaxBytes')
              }
              onChange(next)
            }}
          >
            {t(modality === 'text' ? 'modelInputText' : 'modelInputImage')}
          </Checkbox>
        ))}
      </div>
    </fieldset>
  )
}
