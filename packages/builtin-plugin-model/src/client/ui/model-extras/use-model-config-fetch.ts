import type { ModelDiscoveryChannel } from '../../service/model-config'
import type { ModelDraft, ModelProbeTarget } from './model-config-toolbar'
import type { Translate } from './types'
import { useState } from 'react'
import { loadModelCapacities } from '../../service/model-config'
import { mergeModelCards, modelConfigNotice, withDetail } from '../../service/model-config.utils'
import { loadPresets } from '../../service/presets'
import { modelPresets } from '../../store/modules/model-presets'

export interface UseModelConfigFetchResult {
  busy: boolean
  failure?: string
  notice?: string
  run: (targets?: readonly string[]) => void
}

export interface UseModelConfigFetchOptions {
  t: Translate
  models: readonly ModelDraft[]
  probe: ModelProbeTarget
  operations?: ModelDiscoveryChannel
  onApply?: (models: ModelDraft[], applied: number, undisclosed: string[]) => void
}

export function useModelConfigFetch(options: UseModelConfigFetchOptions): UseModelConfigFetchResult {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [notice, setNotice] = useState<string>()

  const run = (targets?: readonly string[]): void => {
    void (async () => {
      setBusy(true)
      setFailure(undefined)
      setNotice(undefined)
      const [found, presets] = await Promise.all([
        loadModelCapacities({
          settingsNs: options.probe.settingsNs,
          profilePath: options.probe.profilePath,
          ...options.probe.provider === undefined ? {} : { provider: options.probe.provider },
          ...options.probe.baseURL === undefined ? {} : { baseURL: options.probe.baseURL },
          ...options.probe.api === undefined ? {} : { api: options.probe.api },
          ...options.probe.apiKey === undefined ? {} : { apiKey: options.probe.apiKey },
          ...options.probe.headers === undefined ? {} : { headers: options.probe.headers },
        }, options.operations),
        loadPresets(),
      ])
      setBusy(false)
      if (!found.ok && !presets.ok) {
        setFailure(withDetail(options.t('configUnreachable'), found.error))
        return
      }
      const merged = mergeModelCards(options.models, found.ok ? found.models : [], {
        ...targets === undefined ? {} : { targets },
        overwrite: targets === undefined,
        presets: presets.ok ? modelPresets.table : {},
      })
      if (merged.applied > 0)
        options.onApply?.(merged.models, merged.applied, merged.undisclosed)
      // issue #1363：能力表读不到时不能谎称「端点与能力表都没有可用配置」
      if (presets.ok || merged.applied > 0 || merged.undisclosed.length > 0) {
        setNotice(modelConfigNotice(merged, {
          applied: options.t('configApplied'),
          none: options.t('configNoneApplied'),
          undisclosed: options.t('configUndisclosed'),
        }))
      }
      if (!found.ok)
        setFailure(withDetail(options.t('configUnreachable'), found.error))
      else if (!presets.ok)
        setFailure(withDetail(options.t('configPresetsUnavailable'), presets.error))
    })()
  }

  return { busy, failure, notice, run }
}
