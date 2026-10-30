import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { ArchivePanel } from '../components/archive-panel'
import {
  SESSION_REGISTRANT,
  SESSION_SECTION_ID,
  SESSION_SECTION_ORDER,
  SETTINGS_SECTION_SLOT,
} from '../constants'
import { locale } from '../locales'

export const archiveSectionFeature = defineRegister<ClientContext>((controller, ctx, adapter) => {
  controller.add(
    ctx.slots.inject(SETTINGS_SECTION_SLOT as never, () =>
      ctx.slots.register(
        {
          name: SETTINGS_SECTION_SLOT,
          id: SESSION_SECTION_ID,
          order: SESSION_SECTION_ORDER,
          registrant: SESSION_REGISTRANT,
          label: () => locale.text('section'),
          inject: () => ({
            sessionsRuntime: adapter.sessions,
            workspacesRuntime: adapter.workspaces,
          }),
        } as never,
        ArchivePanel,
      )),
  )
})
