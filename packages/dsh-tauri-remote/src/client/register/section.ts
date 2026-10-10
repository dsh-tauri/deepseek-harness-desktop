import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { RemoteSection } from '../components/remote-section'
import { SETTINGS_SECTION_ID, SETTINGS_SECTION_ORDER, SETTINGS_SECTION_SLOT } from '../constants/index'
import { locale } from '../locales/index'

export const sectionFeature = defineRegister<ClientContext>((controller, ctx) => {
  controller.add(ctx.slots.inject(SETTINGS_SECTION_SLOT as never, () => ctx.slots.register({
    name: SETTINGS_SECTION_SLOT,
    id: SETTINGS_SECTION_ID,
    order: SETTINGS_SECTION_ORDER,
    label: () => locale.text('nav'),
    locale: locale.NS,
  } as never, RemoteSection as never)))
})
