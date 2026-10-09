import type { HostContext } from './types'
import { PLUGIN_ID } from '../shared/constants'
import { resetWriteQueue } from './config/runtime'
import { server } from './server'
import { recovery } from './service/recovery'
import { scheduler } from './service/scheduler'
import { createTaskTool } from './tools/create-task'
import { deleteTaskTool } from './tools/delete-task'
import { listTasksTool } from './tools/list-tasks'
import { updateTaskTool } from './tools/update-task'

const SCHEDULER_TICK_MS = 1_000

const SCHEDULER_ROUTES_EFFECT = `${PLUGIN_ID}: routes`

const SCHEDULER_RECOVER_EFFECT = `${PLUGIN_ID}: recover interrupted runs`

const SCHEDULER_TICK_EFFECT = `${PLUGIN_ID}: tick`

const SCHEDULER_RUNTIME_EFFECT = `${PLUGIN_ID}: host runtime`

export interface Config {
  tickMs?: number
}

export function apply(ctx: HostContext, config: Config = {}): void {
  ctx.effect(() => server(ctx), SCHEDULER_ROUTES_EFFECT)

  ctx.tools.register(createTaskTool())
  ctx.tools.register(listTasksTool())
  ctx.tools.register(updateTaskTool())
  ctx.tools.register(deleteTaskTool())

  const tickMs = Number.isFinite(config?.tickMs) && (config.tickMs as number) > 0
    ? (config.tickMs as number)
    : SCHEDULER_TICK_MS

  ctx.effect(() => {
    void recovery.recover().catch((error: unknown) => {
      ctx.logger?.warn?.('dsh-tauri-scheduler: recover interrupted runs failed', error)
    })
  }, SCHEDULER_RECOVER_EFFECT)

  ctx.effect(() => scheduler.start(tickMs), SCHEDULER_TICK_EFFECT)
  ctx.effect(() => () => resetWriteQueue(), SCHEDULER_RUNTIME_EFFECT)
}
