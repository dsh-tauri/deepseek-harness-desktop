import type { Translate } from './types'
import { locale } from '../../locales'

export const MODEL_EXTRAS_KEYS = [
  'openConfigFile',
  'defaultApplication',
  'autoConfigureModels',
  'autoConfigureModelsHint',
  'fetchModelConfig',
  'fetchModelConfigHint',
  'fetchingConfig',
  'configUnreachable',
  'configNoneApplied',
  'configApplied',
  'configUndisclosed',
  'thinkingMode',
  'thinkingLevels',
  'thinkingModeHint',
  'developerRole',
  'developerRoleHint',
] as const

export const modelExtrasTranslate: Translate = (key, params) => (locale.text as Translate)(key, params)
