import type { HostContext } from './types'
import { PLUGIN_ID } from '../shared/constants'
import { resetWriteQueue } from './config/runtime'
import { registerSessionOrigin } from './events/session-origin'
import { server } from './server'
import { scheduler } from './service/scheduler'
import { createTaskTool } from './tools/create-task'
import { deleteTaskTool } from './tools/delete-task'
import { listTasksTool } from './tools/list-tasks'
import { updateTaskTool } from './tools/update-task'

const SCHEDULER_TICK_MS = 1_000

export interface Config {
  tickMs?: number
}

export async function apply(ctx: HostContext, config: Config = {}): Promise<void> {
  ctx.effect(() => server(ctx), `${PLUGIN_ID}: routes`)

  ctx.tools.register(createTaskTool())
  ctx.tools.register(listTasksTool())
  ctx.tools.register(updateTaskTool())
  ctx.tools.register(deleteTaskTool())

  if (ctx.get('sessionProjections') === undefined)
    console.warn('[scheduler origin] Public session projection unavailable; source marks disabled until declared.')
  await ctx.inject(['sessionProjections'], async (scoped: HostContext) => {
    await scoped.effect(() => registerSessionOrigin(scoped), `${PLUGIN_ID}: session origin`)
  })

  const tickMs = Number.isFinite(config?.tickMs) && (config.tickMs as number) > 0
    ? (config.tickMs as number)
    : SCHEDULER_TICK_MS
  ctx.effect(() => startRuntime(tickMs), `${PLUGIN_ID}: host runtime`)
}

function startRuntime(tickMs: number): () => Promise<void> {
  resetWriteQueue()
  const stop = scheduler.start(tickMs)
  return async () => {
    await stop()
    resetWriteQueue()
  }
}
