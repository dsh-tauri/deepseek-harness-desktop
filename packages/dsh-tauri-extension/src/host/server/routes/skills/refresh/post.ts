import type { EventHandlerRequest } from 'h3'
import type { ExtensionRouteDeps, SkillsResponse } from '../../index.types'
import { getServerOptions } from 'dsh-h3/utils'
import { defineEventHandler } from 'h3'
import { skills } from '../../../../service/skills'

export default defineEventHandler<EventHandlerRequest, Promise<SkillsResponse | { error: string }>>(async (event) => {
  try {
    await getServerOptions<ExtensionRouteDeps>(event).remountProvider()
    return { skills: await skills.getCatalog() }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
