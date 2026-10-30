import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'
import { PetSettings } from '../components/pet-settings'
import { PET_SECTION_ID, PET_SECTION_ORDER } from '../constants'
import { locale } from '../locales'
import { createPetSession } from '../service/pet'

/** settings.section 里的桌宠设置分区（与归档分区同点位）。 */
export const petSectionFeature = defineRegister<ClientContext>((controller, ctx, adapter) => {
  controller.add(ctx.slots.inject('settings.section' as never, () => ctx.slots.register({
    name: 'settings.section',
    id: PET_SECTION_ID,
    order: PET_SECTION_ORDER,
    registrant: PLUGIN_ID,
    label: () => locale.text('name'),
    inject: () => ({ onCreate: (close?: () => void) => createPetSession({ adapter, close }) }),
  } as never, PetSettings as never)))
})
