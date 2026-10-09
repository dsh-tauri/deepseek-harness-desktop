import type { EventHandlerRequest } from 'h3'
import type { SshSessionRoleResponse } from '../../index.types'
import { defineEventHandler } from 'h3'
import { session } from '../../../../service/session'
import { guarded } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<SshSessionRoleResponse>>(async event =>
  guarded(event, async () => {
    const role = session.role()
    return { ...role, role: role.remote ? 'remote' : 'local' }
  }))
