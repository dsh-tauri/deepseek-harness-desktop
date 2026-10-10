import type { EventHandlerRequest } from 'h3'
import type { SyncPreviewResponse } from '../../index.types'
import { defineEventHandler } from 'h3'
import { sync } from '../../../../service/sync'
import { guarded } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<SyncPreviewResponse>>(async event =>
  guarded(event, async () => sync.preview()))
