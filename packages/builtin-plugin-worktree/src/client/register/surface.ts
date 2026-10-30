import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { WorktreeSurface } from '../components/surface'
import { INPUT_DOCK_SLOT, SURFACE_ID, SURFACE_ORDER } from '../constants'

export const surfaceFeature = defineRegister<ClientContext>((controller, ctx) => {
  controller.add(ctx.slots.inject(INPUT_DOCK_SLOT as never, () =>
    ctx.slots.register(
      {
        name: INPUT_DOCK_SLOT,
        id: SURFACE_ID,
        order: SURFACE_ORDER,
        inject: (sessionId: string | undefined) => sessionId === undefined ? undefined : { sessionId },
      } as never,
      WorktreeSurface,
    )))
})
