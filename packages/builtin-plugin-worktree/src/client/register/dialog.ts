import type { ClientContext } from 'dsh-tauri/client'
import type { WorktreeDialogProps } from '../components/dialog.types'
import { defineRegister } from 'dsh-tauri/client'
import { WorktreeDialog } from '../components/dialog'
import { DIALOG_ID, PLUGIN_ID, SHELL_OVERLAY_SLOT } from '../constants'

export const dialogFeature = defineRegister<ClientContext>((controller, ctx, adapter) => {
  controller.add(ctx.slots.inject(SHELL_OVERLAY_SLOT, () =>
    ctx.slots.register(
      {
        name: SHELL_OVERLAY_SLOT,
        id: DIALOG_ID,
        registrant: PLUGIN_ID,
        inject: (): Pick<WorktreeDialogProps, 'sessionsRuntime' | 'workspacesRuntime'> => ({
          workspacesRuntime: adapter.workspaces as unknown as WorktreeDialogProps['workspacesRuntime'],
          sessionsRuntime: adapter.sessions as unknown as WorktreeDialogProps['sessionsRuntime'],
        }),
      },
      WorktreeDialog as never,
    )))
})
