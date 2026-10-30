import type { ReactNode } from 'react'
import type { en } from './locales.ts'
import { Plus } from 'dsh-tauri-ui/client'
import { useState } from 'react'
import { useModelRowKeys } from '../hooks/use-model-row-keys'
import { ModelRow } from './ModelRow.tsx'
import { modelStyles as styles } from './styles.ts'

export type DeepSeekModelDraft = Record<string, unknown>

type CatalogField = 'id' | 'name' | 'contextWindow' | 'maxTokens'

type CapacityField = 'contextWindow' | 'maxTokens'

function rowOf(key: string): number {
  return Number(key.slice(0, key.indexOf(':')))
}

const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i

const CAPACITY_SCALE = { k: 1_000, m: 1_000_000 } as const

export function parseCapacity(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0)
    return undefined
  const match = CAPACITY_PATTERN.exec(trimmed)
  if (match === null)
    return Number.NaN
  const suffix = match[2]?.toLowerCase()
  const scale = suffix === 'k' || suffix === 'm' ? CAPACITY_SCALE[suffix] : 1
  const scaled = Number(match[1]) * scale

  const rounded = Math.round(scaled)
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled
}

export function formatCapacity(value: number): string {
  if (!Number.isInteger(value) || value <= 0)
    return String(value)
  if (value % CAPACITY_SCALE.m === 0)
    return `${String(value / CAPACITY_SCALE.m)}M`
  if (value % CAPACITY_SCALE.k === 0)
    return `${String(value / CAPACITY_SCALE.k)}K`
  return String(value)
}

export interface DeepSeekModelsValidationFailure {
  index: number
  key: 'modelIdRequired' | 'modelIdDuplicate' | 'modelNameInvalid' | 'modelContextInvalid'
    | 'modelMaxTokensInvalid'
}

export function modelDrafts(value: unknown): DeepSeekModelDraft[] {
  if (!Array.isArray(value))
    return []
  return value.map(entry =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? entry as DeepSeekModelDraft
      : {})
}

export function validateDeepSeekModels(value: unknown): DeepSeekModelsValidationFailure | undefined {
  if (value === undefined)
    return undefined
  const models = modelDrafts(value)
  const seen = new Set<string>()
  for (const [index, model] of models.entries()) {
    const id = model.id
    const trimmed = typeof id === 'string' ? id.trim() : undefined
    if (trimmed === undefined || trimmed.length === 0)
      return { index, key: 'modelIdRequired' }
    if (seen.has(trimmed))
      return { index, key: 'modelIdDuplicate' }
    seen.add(trimmed)
    const name = model.name
    if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
      return { index, key: 'modelNameInvalid' }
    }
    const contextWindow = model.contextWindow
    if (contextWindow !== undefined
      && (typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow <= 0)) {
      return { index, key: 'modelContextInvalid' }
    }
    const maxTokens = model.maxTokens
    if (maxTokens !== undefined
      && (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0)) {
      return { index, key: 'modelMaxTokensInvalid' }
    }
  }
  return undefined
}

export interface DeepSeekModelsEditorProps {
  models: readonly DeepSeekModelDraft[]
  overridden: boolean
  defaultContextWindow: number | undefined
  defaultMaxTokens: number | undefined
  t: (key: keyof typeof en) => string
  disabled: boolean
  onChange: (models: DeepSeekModelDraft[]) => void
  onReset: () => void
}

export function DeepSeekModelsEditor(props: DeepSeekModelsEditorProps): ReactNode {
  const rowKeys = useModelRowKeys(props.models)
  const [editing, setEditing] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())

  const update = (index: number, key: CatalogField, value: unknown): void => {
    const next = props.models.map((model, at) => {
      if (at !== index)
        return model
      const copy = { ...model }
      if (value === undefined)
        Reflect.deleteProperty(copy, key)
      else copy[key] = value
      return copy
    })
    props.onChange(next)
  }

  const remove = (index: number): void => {
    setEditing((current) => {
      const next = new Map<string, string>()
      for (const [key, text] of current) {
        const at = rowOf(key)
        if (at === index)
          continue

        next.set(at > index ? key.replace(/^\d+/, String(at - 1)) : key, text)
      }
      return next
    })
    setExpanded((current) => {
      const next = new Set<number>()
      for (const at of current) {
        if (at === index)
          continue
        next.add(at > index ? at - 1 : at)
      }
      return next
    })
    props.onChange(props.models.filter((_model, at) => at !== index))
  }

  const reset = (): void => {
    setEditing(new Map())
    setExpanded(new Set())
    props.onReset()
  }

  const toggle = (index: number): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(index))
        next.add(index)
      return next
    })
  }

  const capacityText = (model: DeepSeekModelDraft, index: number, field: CapacityField): string => {
    const typed = editing.get(`${String(index)}:${field}`)
    if (typed !== undefined)
      return typed
    const value = model[field]
    return typeof value === 'number' ? formatCapacity(value) : ''
  }

  const settleCapacity = (index: number, field: CapacityField): void => {
    const key = `${String(index)}:${field}`
    const typed = editing.get(key)
    if (typed === undefined)
      return

    const parsed = parseCapacity(typed)
    if (parsed !== undefined && Number.isNaN(parsed))
      return
    setEditing((current) => {
      const next = new Map(current)
      next.delete(key)
      return next
    })
  }

  const capacityInput = (model: DeepSeekModelDraft, index: number, field: CapacityField, fallback: number | undefined) => ({
    value: capacityText(model, index, field),
    placeholder: fallback === undefined
      ? props.t(field === 'contextWindow' ? 'contextWindowPlaceholder' : 'maxTokensPlaceholder')
      : formatCapacity(fallback),
    onChange: (text: string) => {
      setEditing(current => new Map(current).set(`${String(index)}:${field}`, text))
      update(index, field, parseCapacity(text))
    },
    onBlur: () => { settleCapacity(index, field) },
  })

  return (
    <section className={styles.modelCatalog} aria-label={props.t('models')}>
      <div className={styles.modelListHead}>
        <div className={styles.modelCatalogHeading}>
          <span className={styles.modelCatalogTitle}>{props.t('models')}</span>
          <span className={styles.modelCatalogMeta}>
            {props.overridden ? props.t('modelsCustomized') : props.t('modelsInherited')}
          </span>
        </div>
        {props.overridden
          ? (
              <button
                type="button"
                className={styles.linkButton}
                disabled={props.disabled}
                onClick={reset}
              >
                {props.t('resetModels')}
              </button>
            )
          : null}
      </div>
      {props.models.length === 0
        ? <p className={styles.modelEmpty}>{props.t('modelsEmpty')}</p>
        : (
            <div className={styles.modelList}>
              {props.models.map((model, index) => (
                <ModelRow
                  key={rowKeys[index]}
                  model={model}
                  position={index + 1}
                  inputField="inputModalities"
                  expanded={expanded.has(index)}
                  disabled={props.disabled}
                  t={props.t}
                  contextWindow={capacityInput(model, index, 'contextWindow', props.defaultContextWindow)}
                  maxTokens={capacityInput(model, index, 'maxTokens', props.defaultMaxTokens)}
                  onFieldChange={(field, value) => { update(index, field, value) }}
                  onIdBlur={(value) => {
                    const trimmed = value.trim()
                    if (trimmed !== value)
                      update(index, 'id', trimmed)
                  }}
                  onChange={(next) => { props.onChange(props.models.map((row, at) => at === index ? next : row)) }}
                  onToggle={() => { toggle(index) }}
                  onRemove={() => { remove(index) }}
                />
              ))}
            </div>
          )}
      <button
        type="button"
        className={styles.addModelButton}
        disabled={props.disabled}
        onClick={() => { props.onChange([...props.models, { id: '' }]) }}
      >
        <Plus width={14} height={14} />
        {props.t('addModel')}
      </button>
    </section>
  )
}
