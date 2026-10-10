import type { MenuEntry } from 'dsh-tauri-ui/client'
import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import type { ModelCatalogFailure, ModelOption } from '../types'
import { ChevronDown, Chip, Icon, Menu } from 'dsh-tauri-ui/client'
import { groupBy, useEventListener, useWatchImmediate } from 'dsh-tauri/client'
import { useState } from 'react'

type Pane = 'root' | 'model' | 'effort'

function optionCopy(label: string, description?: string): ReactElement {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-[14px] font-medium leading-[20px]">{label}</span>
      {description !== undefined && <span className="truncate text-tertiary text-[12px] leading-[18px]">{description}</span>}
    </span>
  )
}

function paneRow(label: string, hint: string): ReactElement {
  return (
    <span className="flex items-center justify-between gap-[12px] w-full">
      <span className="flex-none">{label}</span>
      <span className="flex-1 min-w-0 text-tertiary text-right truncate">{hint}</span>
    </span>
  )
}

export function ModelPicker({
  t,
  models,
  failures,
  modelKey,
  reasoningEffort,
  onSelection,
  disabled,
}: {
  readonly t: Translate
  readonly models: readonly ModelOption[]
  readonly failures: readonly ModelCatalogFailure[]
  readonly modelKey: string
  readonly reasoningEffort: string
  readonly onSelection: (modelKey: string, reasoningEffort: string) => void
  readonly disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  useWatchImmediate(disabled, () => {
    if (disabled)
      setOpen(false)
  })
  const selected = models.find(item => `${item.provider}::${item.model}` === modelKey)
  const reasoning = selected?.reasoning
  const effectiveEffort = reasoningEffort === 'none'
    ? reasoning?.defaultEffort
    : reasoningEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(item => item.id === effectiveEffort)?.name ?? effectiveEffort
  const trigger = selected?.label ?? (modelKey !== 'default' ? modelKey : t('trigger.fallback'))
  const modelGroups = Object.entries(groupBy(models, 'provider')).map(([provider, group]) => ({
    provider,
    label: group[0]?.providerLabel ?? provider,
    models: group,
  }))

  useEventListener('keydown', (event) => {
    if (!open || event.key !== 'Escape')
      return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    if (pane !== 'root') {
      setPane('root')
      return
    }
    setOpen(false)
  }, true)

  const selectModel = (value: string): void => {
    const item = models.find(model => `${model.provider}::${model.model}` === value)
    onSelection(value, item?.reasoning?.defaultEffort ?? 'none')
    setOpen(false)
    setPane('root')
  }

  const selectEffort = (effort: string): void => {
    onSelection(modelKey, effort)
    setOpen(false)
    setPane('root')
  }

  const rootItems: MenuEntry[] = [
    { id: 'pane:model', label: paneRow(t('menu.model'), trigger) },
  ]
  if (reasoning !== undefined)
    rootItems.push({ id: 'pane:effort', label: paneRow(t('menu.effort'), effortLabel ?? t('effort.providerDefault')) })

  const modelItems: MenuEntry[] = [{ id: 'model:default', label: optionCopy(t('followGlobal')) }, ...failures.map<MenuEntry>(failure => ({
    type: 'label',
    id: `warning:${failure.provider}`,
    text: t('warning.groupLoad', { name: failure.providerLabel, message: failure.message }),
  }))]
  for (const group of modelGroups) {
    modelItems.push({ type: 'label', id: `group:${group.provider}`, text: group.label })
    for (const item of group.models)
      modelItems.push({ id: `model:${item.provider}::${item.model}`, label: optionCopy(item.label, item.description) })
  }
  if (modelItems.length === 1)
    modelItems.push({ type: 'label', id: 'empty:models', text: t('empty.models') })

  const effortItems: MenuEntry[] = []
  if (reasoning !== undefined) {
    if (reasoning.defaultEffort === undefined)
      effortItems.push({ id: 'effort:none', label: optionCopy(t('effort.providerDefault')) })
    for (const item of reasoning.efforts)
      effortItems.push({ id: `effort:${item.id}`, label: optionCopy(item.name, item.description) })
    if (effortItems.length === 0)
      effortItems.push({ type: 'label', id: 'empty:efforts', text: t('empty.efforts') })
  }

  const items = pane === 'root' ? rootItems : pane === 'model' ? modelItems : effortItems
  const selectedId = pane === 'model'
    ? `model:${modelKey}`
    : pane === 'effort'
      ? `effort:${effectiveEffort ?? 'none'}`
      : undefined

  const onSelect = (id: string): void => {
    if (disabled)
      return
    if (id === 'pane:model') {
      setPane('model')
      return
    }
    if (id === 'pane:effort') {
      setPane('effort')
      return
    }
    if (id.startsWith('model:')) {
      selectModel(id.slice('model:'.length))
      return
    }
    if (id.startsWith('effort:'))
      selectEffort(id.slice('effort:'.length))
  }

  return (
    <Menu
      open={open && !disabled}
      autoFocus
      portal
      side="top"
      align="end"
      items={items}
      selectedId={selectedId}
      onSelect={onSelect}
      onClose={() => {
        setOpen(false)
        setPane('root')
      }}
      anchor={(
        <Chip
          disabled={disabled}
          variant="composerTrigger"
          open={open && !disabled}
          aria-label={selected === undefined
            ? t('trigger.selectAria')
            : effortLabel === undefined
              ? t('trigger.aria', { model: selected.label })
              : t('trigger.ariaEffort', { model: selected.label, effort: effortLabel })}
          aria-haspopup="menu"
          aria-expanded={open}
          onMouseDown={event => event.stopPropagation()}
          onClick={() => {
            if (open) {
              setOpen(false)
              return
            }
            setPane('root')
            setOpen(true)
          }}
          badge={effortLabel === undefined
            ? undefined
            : <span className="flex-none text-tertiary whitespace-nowrap">{effortLabel}</span>}
          chevron={<Icon as={ChevronDown} />}
        >
          <span className="min-w-0 truncate">{trigger}</span>
        </Chip>
      )}
    />
  )
}
