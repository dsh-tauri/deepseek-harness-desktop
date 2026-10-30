import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { SETTINGS_ONBOARDING_SLOT, SETTINGS_SECTION_SLOT } from '../constants'
import { loadOnboardingSteps, loadSections } from '../service/sections'

export const registerSettingsSections = defineRegister<ClientContext>((controller, ctx) => {
  const sync = (): void => {
    void loadSections(ctx.slots)
    void loadOnboardingSteps(ctx.slots)
  }

  sync()
  controller.add(ctx.slots.subscribe(SETTINGS_SECTION_SLOT as never, sync))
  controller.add(ctx.slots.subscribe(SETTINGS_ONBOARDING_SLOT as never, sync))
  controller.add(ctx.locale.subscribe(sync))
})
