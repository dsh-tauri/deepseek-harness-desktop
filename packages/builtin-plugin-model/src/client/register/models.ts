import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DeepSeekOnboardingInjected } from '../models/DeepSeekOnboardingDialog.tsx'
import type { ModelsSectionInjected } from '../models/ModelsSection.tsx'
import type {} from '../models/slot-contract.ts'
import type { WelcomeNoticeInjected } from '../models/WelcomeNotice.tsx'
import { defineRegister } from 'dsh-tauri/client'
import { ONBOARDING_CONFIG_GLOBAL } from '../../shared/onboarding-config.ts'
import { locale } from '../locales'
import { DeepSeekOnboardingDialog } from '../models/DeepSeekOnboardingDialog.tsx'
import { ModelsSection } from '../models/ModelsSection.tsx'
import { createModelsOperations } from '../models/operations.ts'
import { resolveRemote } from '../models/remote.ts'
import { createSettingsSchemaOperations } from '../models/schema-operations.ts'
import { resolveModelsForms } from '../models/settings-forms.ts'
import { ModelsSettingsStore } from '../models/store.ts'
import { WelcomeNoticeStore } from '../models/welcome-store.ts'
import { WelcomeNotice } from '../models/WelcomeNotice.tsx'

function refreshIfLoaded(controller: ModelsSettingsStore): void {
  if (controller.store.getSnapshot().status === 'idle')
    return
  void controller.load()
}

function isDesktopCarrier(): boolean {
  return 'dshDesktop' in globalThis
}

function credentialOnboardingOf(): boolean {
  const page = globalThis as Partial<Record<typeof ONBOARDING_CONFIG_GLOBAL, unknown>>
  const payload = page[ONBOARDING_CONFIG_GLOBAL]
  const value = typeof payload === 'object' && payload !== null
    ? (payload as { credentialOnboarding?: unknown }).credentialOnboarding
    : undefined
  return (value ?? true) === true && !isDesktopCarrier()
}

export const registerModelsPage = defineRegister<ClientContext>((controller, ctx) => {
  const remote = resolveRemote(ctx)
  const forms = resolveModelsForms(ctx)
  if (remote === undefined || forms === undefined)
    return
  const schema = createSettingsSchemaOperations(ctx.settingsSchema)
  const operations = createModelsOperations(remote)
  const page = new ModelsSettingsStore(remote, schema, forms.describe)
  const t = locale.text as ModelsSectionInjected['t']
  const injected = (): ModelsSectionInjected => ({
    controller: page,
    hooks: { snapshot: page.store },
    operations,
    schema,
    t,
  })
  const deepSeekOnboardingInjected = (): DeepSeekOnboardingInjected => ({
    automatic: credentialOnboardingOf(),
    controller: page,
    hooks: { models: page.store },
    operations,
    schema,
    t,
  })
  const welcome = new WelcomeNoticeStore(forms.welcome)
  const welcomeInjected = (): WelcomeNoticeInjected => ({
    controller: welcome,
    hooks: { welcome: welcome.store },
    t,
  })

  const refreshModels = (): void => {
    refreshIfLoaded(page)
  }
  const disposers = [
    remote.$on('settings/document-updated', () => {
      refreshModels()
    }),
    remote.$on('credentials/record-updated', refreshModels),
    remote.$on('credentials/reference-updated', refreshModels),
    remote.$on('llm/adapters-updated', refreshModels),
    ctx.on('connection/reset', refreshModels),
  ]
  controller.add(() => {
    welcome.dispose()
    for (const dispose of disposers) dispose()
  })

  controller.add(ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'models',
    order: 10,
    label: () => t('nav'),
    inject: injected,
    children: {
      'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
      'settings.models.footer': { kind: 'list', scope: 'root' },
    },
  }, ModelsSection)))
  if (!isDesktopCarrier()) {
    controller.add(ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
      name: 'settings.onboarding',
      id: 'welcome-notice',
      order: -100,
      inject: welcomeInjected,
    }, WelcomeNotice)))
  }
  controller.add(ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'deepseek-official',
    children: { 'settings.models.sign-in': { kind: 'single', scope: 'root' } },
    order: 0,
    inject: deepSeekOnboardingInjected,
  }, DeepSeekOnboardingDialog)))
})
