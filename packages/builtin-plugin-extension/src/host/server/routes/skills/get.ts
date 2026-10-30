import type { EventHandlerRequest } from 'h3'
import type { SkillsResponse } from '../index.types'
import { defineEventHandler } from 'h3'
import { skills } from '../../../service/skills'

export default defineEventHandler<EventHandlerRequest, Promise<SkillsResponse | { error: string }>>(async (event) => {
  try {
    return { skills: await skills.getCatalog() }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
