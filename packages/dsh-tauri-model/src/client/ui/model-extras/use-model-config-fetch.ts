import type { ModelDiscoveryChannel } from '../../service/model-config'
import type { ModelDraft, ModelProbeTarget } from './model-config-toolbar'
import type { Translate } from './types'
import { useCallback, useState } from 'react'
import { loadModelCapacities } from '../../service/model-config'
import { mergeModelCards, modelConfigNotice, withDetail } from '../../service/model-config.utils'
import { ensurePresets } from '../../service/presets'

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

  const run = useCallback((targets?: readonly string[]) => {
    void (async () => {
      setBusy(true)
      setFailure(undefined)
      const [found] = await Promise.all([
        loadModelCapacities({
          settingsNs: options.probe.settingsNs,
          profilePath: options.probe.profilePath,
          ...options.probe.provider === undefined ? {} : { provider: options.probe.provider },
          ...options.probe.baseURL === undefined ? {} : { baseURL: options.probe.baseURL },
          ...options.probe.api === undefined ? {} : { api: options.probe.api },
          ...options.probe.apiKey === undefined ? {} : { apiKey: options.probe.apiKey },
          ...options.probe.headers === undefined ? {} : { headers: options.probe.headers },
        }, options.operations),
        ensurePresets(),
      ])
      setBusy(false)
      if (!found.ok) {
        setNotice(undefined)
        setFailure(withDetail(options.t('configUnreachable'), found.error))
        return
      }
      const merged = mergeModelCards(options.models, found.models, {
        ...targets === undefined ? {} : { targets },
        overwrite: targets === undefined,
      })
      if (merged.applied > 0)
        options.onApply?.(merged.models, merged.applied, merged.undisclosed)
      setNotice(modelConfigNotice(merged, {
        applied: options.t('configApplied'),
        none: options.t('configNoneApplied'),
        undisclosed: options.t('configUndisclosed'),
      }))
    })()
  }, [options])

  return { busy, failure, notice, run }
}
