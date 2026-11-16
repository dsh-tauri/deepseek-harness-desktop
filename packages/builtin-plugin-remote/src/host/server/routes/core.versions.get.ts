import type { EventHandlerRequest } from 'h3'
import type { RemoteCoreVersionsResponse } from './index.types'
import { defineEventHandler } from 'h3'
import { core } from '../../service/core'
import { guarded } from './index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteCoreVersionsResponse>>(async event =>
  guarded(event, async () => ({ items: await core.listVersions() })))
