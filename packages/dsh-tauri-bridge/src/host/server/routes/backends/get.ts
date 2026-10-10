import type { EventHandlerRequest } from 'h3'
import type { BackendDetection } from '../../../../shared/types'
import { defineEventHandler } from 'h3'
import { backend } from '../../../service/backend'

export default defineEventHandler<EventHandlerRequest, Promise<BackendDetection[]>>(() => backend.getCatalog())
