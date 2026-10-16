import type { EventHandlerRequest } from 'h3'
import type { RemoteSessionRoleResponse } from '../../index.types'
import { defineEventHandler } from 'h3'
import { session } from '../../../../service/session'
import { isLocalRequest } from '../../../panel.utils'
import { guarded } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteSessionRoleResponse>>(async event =>
  guarded(event, async () => {
    const role = session.role()
    const remote = !isLocalRequest(event)
    return { ...role, remote, role: remote ? 'remote' : 'local' }
  }))
