import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { SessionProjectionMap as ClientProjectionMap } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { NativeTurnOptions } from '../packages/dsh-tauri-kernel/src/shared/native-model'
import type { KernelBinding } from '../packages/dsh-tauri-kernel/src/shared/types'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { SESSION_SCHEDULE_ORIGIN_PROJECTION } from '../packages/dsh-tauri-scheduler/src/shared/constants'

describe('session projection augmentation contracts', () => {
  it('keeps scheduler, bridge and upstream projections identical through canonical and client exports', () => {
    expect(SESSION_SCHEDULE_ORIGIN_PROJECTION).toBe('dsh-tauri-scheduler.origin')
    expectTypeOf<SessionProjectionMap[typeof SESSION_SCHEDULE_ORIGIN_PROJECTION]>().toEqualTypeOf<boolean>()
    expectTypeOf<SessionProjectionMap['bridgeModel']>().toEqualTypeOf<NativeTurnOptions>()
    expectTypeOf<SessionProjectionMap['bridgeKernel']>().toEqualTypeOf<KernelBinding | null>()
    expectTypeOf<SessionProjectionMap['agentPreset']>().toEqualTypeOf<string | null>()
    expectTypeOf<ClientProjectionMap>().toEqualTypeOf<SessionProjectionMap>()
  })
})
