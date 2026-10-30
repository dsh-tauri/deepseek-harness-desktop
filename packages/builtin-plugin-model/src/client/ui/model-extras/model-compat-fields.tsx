import type { ReactElement } from 'react'
import type { Translate } from './types'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { useStore } from 'dsh-tauri/client'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  declaredThinkingLevels,
  enableThinking,
  isThinkingEnabled,
  supportsTemplateThinking,
  templateThinkingCompat,
  THINKING_LEVELS,
  thinkingEffortsOf,
  toggleThinkingLevel,
  wireValueOf,
} from '../../service/model-compat'
import { presetFor } from '../../service/model-presets'
import { modelPresets } from '../../store/modules/model-presets'

const FIELD = 'flex flex-col gap-[4px] min-w-0'
const LABEL = 'p-0 text-tertiary text-[12px] leading-[18px]'
const SWITCH_ROW = 'flex items-center h-[32px]'
const CHIP = 'inline-flex items-center gap-[4px] h-[24px] px-[8px] border-[0.5px] border-border-l3 rounded-[6px] text-[12px] leading-[18px] text-secondary cursor-pointer [&:has(input:disabled)]:opacity-60 [&:has(input:disabled)]:cursor-default [&_input]:w-[12px] [&_input]:h-[12px] [&_input]:m-0 [&_input]:accent-brand [&_input:focus-visible]:shadow-focus-ring'

export interface ModelCompatFieldsProps {
  t: Translate
  model: Record<string, unknown>
  index: number
  templateCompat: boolean
  onPatch: (patch: Record<string, unknown>) => void
  disabled?: boolean | undefined
}

export function ModelCompatFields({
  t,
  model,
  index,
  templateCompat,
  onPatch,
  disabled,
}: ModelCompatFieldsProps): ReactElement {
  const position = index + 1
  const id = typeof model.id === 'string' ? model.id : ''
  const { table } = useStore(modelPresets)
  const preset = presetFor(table, id)
  const presetEfforts = preset?.reasoningEfforts && typeof preset.reasoningEfforts === 'object'
    ? preset.reasoningEfforts
    : undefined
  const [customEfforts, setCustomEfforts] = useState<Record<string, string | null>>(() => ({ ...thinkingEffortsOf(model) }))
  const declared = declaredThinkingLevels(model)
  const isLocalPatchRef = useRef(false)
  const [forceOpen, setForceOpen] = useState(false)

  useEffect(() => {
    if (isLocalPatchRef.current) {
      isLocalPatchRef.current = false
    }
    else {
      setForceOpen(false)
      setCustomEfforts({ ...thinkingEffortsOf(model) })
    }
  }, [model])

  const thinkingActive = isThinkingEnabled(model) || forceOpen

  const candidateLevels = useMemo(() => {
    const base = [...THINKING_LEVELS]
    const extra = Object.keys(customEfforts).filter(level => !(base as readonly string[]).includes(level))
    return extra.length > 0 ? [...base, ...extra] : base
  }, [customEfforts])

  return (
    <>
      <div className="order-[1] flex gap-[16px] min-w-0 m-0 p-0 border-none">
        <div className={FIELD}>
          <span data-slot="model-compat-label" className={LABEL} title={t('thinkingModeHint')}>{t('thinkingMode')}</span>
          <div className={SWITCH_ROW}>
            <Switch
              checked={thinkingActive}
              disabled={disabled}
              label={`${t('thinkingMode')} ${String(position)}`}
              title={t('thinkingModeHint')}
              onChange={(next) => {
                isLocalPatchRef.current = true
                setForceOpen(false)
                onPatch({ reasoningEfforts: next ? enableThinking(model, preset) : false })
              }}
            />
          </div>
        </div>
        {templateCompat
          ? (
              <div className={FIELD}>
                <span data-slot="model-compat-label" className={LABEL} title={t('developerRoleHint')}>{t('developerRole')}</span>
                <div className={SWITCH_ROW}>
                  <Switch
                    checked={supportsTemplateThinking(model)}
                    disabled={disabled}
                    label={`${t('developerRole')} ${String(position)}`}
                    title={t('developerRoleHint')}
                    onChange={(next) => { onPatch({ compat: templateThinkingCompat(model, next) }) }}
                  />
                </div>
              </div>
            )
          : null}
      </div>
      {thinkingActive
        ? (
            <div className="order-[3] col-span-full flex flex-col gap-[4px]" role="group" aria-label={`${t('thinkingLevels')} ${String(position)}`}>
              <span data-slot="model-compat-label" className={LABEL}>{t('thinkingLevels')}</span>
              <div className="flex flex-wrap gap-[6px]">
                {candidateLevels.map((level) => {
                  const wireValue = wireValueOf(level, customEfforts, presetEfforts)
                  return (
                    <label key={level} data-slot="model-compat-chip" className={CHIP}>
                      <input
                        type="checkbox"
                        checked={declared.includes(level)}
                        disabled={disabled}
                        onChange={(event) => {
                          isLocalPatchRef.current = true
                          const nextEfforts = toggleThinkingLevel(
                            thinkingEffortsOf(model),
                            level,
                            event.target.checked,
                            wireValue,
                          )
                          if (nextEfforts === false)
                            setForceOpen(true)
                          else
                            setForceOpen(false)
                          onPatch({ reasoningEfforts: nextEfforts })
                        }}
                      />
                      {level}
                    </label>
                  )
                })}
              </div>
            </div>
          )
        : null}
    </>
  )
}
