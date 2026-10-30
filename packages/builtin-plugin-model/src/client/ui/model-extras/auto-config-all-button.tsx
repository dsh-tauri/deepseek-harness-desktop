import type { ReactElement } from 'react'
import type { ModelDiscoveryChannel } from '../../service/model-config'
import type { ModelDraft, ModelProbeTarget } from './model-config-toolbar'
import type { Translate } from './types'
import { Action, Text } from 'dsh-tauri-ui/client'
import { useModelConfigFetch } from './use-model-config-fetch'

export interface AutoConfigAllButtonProps {
  t: Translate
  models: readonly ModelDraft[]
  probe: ModelProbeTarget
  operations?: ModelDiscoveryChannel
  disabled?: boolean
  onApply?: (models: ModelDraft[], applied: number, undisclosed: string[]) => void
}

export function AutoConfigAllButton({ t, models, probe, operations, disabled, onApply }: AutoConfigAllButtonProps): ReactElement {
  const { busy, failure, notice, run } = useModelConfigFetch({ t, models, probe, operations, onApply })

  return (
    <>
      <Action
        variant="link"
        disabled={disabled === true || busy || models.length === 0}
        title={t('autoConfigureModelsHint')}
        aria-busy={busy}
        onClick={() => run()}
      >
        {busy ? t('fetchingConfig') : t('autoConfigureModels')}
      </Action>
      {failure === undefined ? null : <Text tone="error" className="flex-[1_1_100%] min-w-0 [overflow-wrap:anywhere]" role="alert">{failure}</Text>}
      {notice === undefined ? null : <Text tone="success" className="flex-[1_1_100%] min-w-0 [overflow-wrap:anywhere]">{notice}</Text>}
    </>
  )
}
