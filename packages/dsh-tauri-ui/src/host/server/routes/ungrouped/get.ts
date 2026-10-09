import type { EventHandlerRequest } from 'h3'
import type { UngroupedResponse } from '../index.types'
import { defineEventHandler } from 'h3'
import { ungrouped } from '../../../service/ungrouped'

export default defineEventHandler<EventHandlerRequest, UngroupedResponse>(() => {
  try {
    return { cwd: ungrouped.resolve() }
  }
  catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
