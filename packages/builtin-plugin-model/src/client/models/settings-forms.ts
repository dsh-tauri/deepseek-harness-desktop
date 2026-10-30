import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ServiceLookup } from './remote.ts'
import type { WelcomeSettingsForm } from './welcome-store.ts'
import {
  WELCOME_NOTICE_SETTINGS_NAMESPACE,
  WELCOME_NOTICE_SETTINGS_NAMESPACE_LEGACY,
} from '../../shared/onboarding-copy.ts'
import { decodeWelcomeSection } from './welcome-store.ts'

interface ConfigFormsLike {
  describe: () => SettingsDescribeFace
  get: (namespace: string) => WelcomeSettingsForm
}

interface SettingsScopeLike {
  describe: () => SettingsDescribeFace
  bind: (spec: { namespace: string, decode: (section: unknown) => Record<string, unknown> }) => WelcomeSettingsForm
}

export interface ModelsForms {
  describe: SettingsDescribeFace
  welcome: WelcomeSettingsForm
}

export type { ServiceLookup } from './remote.ts'

export function resolveModelsForms(ctx: ServiceLookup): ModelsForms | undefined {
  const forms = ctx.get('configForms') as ConfigFormsLike | undefined
  if (forms !== undefined) {
    return {
      describe: forms.describe(),
      welcome: forms.get(WELCOME_NOTICE_SETTINGS_NAMESPACE),
    }
  }
  const scope = ctx.get('settingsScope') as SettingsScopeLike | undefined
  if (scope === undefined)
    return undefined
  return {
    describe: scope.describe(),
    welcome: scope.bind({
      namespace: WELCOME_NOTICE_SETTINGS_NAMESPACE_LEGACY,
      decode: decodeWelcomeSection,
    }),
  }
}
