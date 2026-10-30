import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { HostContext } from '../types'
import { SESSION_SCHEDULE_ORIGIN_PROJECTION } from '../../shared/constants'

export async function registerSessionOrigin(ctx: HostContext): Promise<() => void> {
  try {
    const module = await ctx.loader.import('zod')
    const z = module.z ?? ctx.loader.unwrapExports(module).z
    const stateSchema = z.object({ inheritedEventCount: z.number().int().nonnegative(), created: z.boolean() })
    return ctx.sessionProjections.register({
      key: SESSION_SCHEDULE_ORIGIN_PROJECTION,
      stateVersion: 1,
      stateSchema,
      init: (_header: SessionHeader, inheritedEventCount: number) => ({ inheritedEventCount, created: false }),
      apply: (state: { inheritedEventCount: number, created: boolean }, event: SessionEvent) => {
        if (state.created || event.seq < state.inheritedEventCount || event.type !== 'user/message' || event.data.source.kind !== 'scheduler')
          return state
        return { ...state, created: true }
      },
      wire: { viewSchema: z.boolean(), view: (state: { created: boolean }) => state.created },
    })
  }
  catch (error) {
    console.warn('[scheduler origin] Public session projection unavailable; source marks disabled.', error)
    return () => {}
  }
}
