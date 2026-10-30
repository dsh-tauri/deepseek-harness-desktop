import type { EventHandlerRequest } from 'h3'
import type { SchedulerOptions } from '../../../types'
import { defineEventHandler } from 'h3'
import { options } from '../../../service/options'

export default defineEventHandler<EventHandlerRequest, Promise<SchedulerOptions>>(async () => options.resolve())
