import type { ReactElement } from 'react'
import type { ModelDiscoveryChannel } from '../../service/model-config'
import type { ModelDraft, ModelProbeTarget } from './model-config-toolbar'
import type { Translate } from './types'
import { Action, Text } from 'dsh-tauri-ui/client'
import { hasModelConfig } from '../../service/model-config.utils'
import { useModelConfigFetch } from './use-model-config-fetch'

export interface ModelFetchConfigButtonProps {
  t: Translate
  modelId: string
  models: readonly ModelDraft[]
  probe: ModelProbeTarget
  operations?: ModelDiscoveryChannel
  disabled?: boolean
  onApply?: (models: ModelDraft[], applied: number, undisclosed: string[]) => void
}

export function ModelFetchConfigButton({
  t,
  modelId,
  models,
  probe,
  operations,
  disabled,
  onApply,
}: ModelFetchConfigButtonProps): ReactElement | null {
  const { busy, failure, run } = useModelConfigFetch({ t, models, probe, operations, onApply })
  const row = models.find(model => model.id === modelId)
  if (row !== undefined && hasModelConfig(row))
    return null

  return (
    <div className="flex items-center flex-wrap gap-[8px] min-w-0">
      <Action
        variant="link"
        disabled={disabled === true || busy}
        title={t('fetchModelConfigHint')}
        aria-busy={busy}
        onClick={() => run([modelId])}
      >
        {busy ? t('fetchingConfig') : t('fetchModelConfig')}
      </Action>
      {failure === undefined ? null : <Text tone="error" className="flex-[1_1_100%] min-w-0 [overflow-wrap:anywhere]" role="alert">{failure}</Text>}
    </div>
  )
}
