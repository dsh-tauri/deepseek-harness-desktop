import type { ReactElement } from 'react'
import type { Translate } from './types'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  declaredThinkingLevels,
  enableThinking,
  supportsTemplateThinking,
  supportsThinking,
  templateThinkingCompat,
  THINKING_LEVELS,
  thinkingEffortsOf,
  toggleThinkingLevel,
} from '../../service/model-compat'

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
  return (
    <>
      <div className="order-[1] flex gap-[16px] min-w-0 m-0 p-0 border-none">
        <div className={FIELD}>
          <span data-slot="model-compat-label" className={LABEL} title={t('thinkingModeHint')}>{t('thinkingMode')}</span>
          <div className={SWITCH_ROW}>
            <Switch
              checked={supportsThinking(model)}
              disabled={disabled}
              label={`${t('thinkingMode')} ${String(position)}`}
              title={t('thinkingModeHint')}
              onChange={(next) => { onPatch({ reasoningEfforts: next ? enableThinking(model) : false }) }}
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
      {supportsThinking(model)
        ? (
            <div className="order-[3] col-span-full flex flex-col gap-[4px]" role="group" aria-label={`${t('thinkingLevels')} ${String(position)}`}>
              <span data-slot="model-compat-label" className={LABEL}>{t('thinkingLevels')}</span>
              <div className="flex flex-wrap gap-[6px]">
                {THINKING_LEVELS.map(level => (
                  <label key={level} data-slot="model-compat-chip" className={CHIP}>
                    <input
                      type="checkbox"
                      checked={declaredThinkingLevels(model).includes(level)}
                      disabled={disabled}
                      onChange={(event) => {
                        onPatch({
                          reasoningEfforts: toggleThinkingLevel(
                            thinkingEffortsOf(model),
                            level,
                            event.target.checked,
                          ),
                        })
                      }}
                    />
                    {level}
                  </label>
                ))}
              </div>
            </div>
          )
        : null}
    </>
  )
}
