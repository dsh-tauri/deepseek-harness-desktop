import type { EventHandlerRequest } from 'h3'
import type { ActionResult, SkillDeleteBody } from '../index.types'
import { defineEventHandler, readBody } from 'h3'
import { skills } from '../../../service/skills'

export default defineEventHandler<EventHandlerRequest, Promise<ActionResult | { error: string }>>(async (event) => {
  const body = await readBody<SkillDeleteBody>(event, { type: 'json' })
  const name = typeof body?.name === 'string' ? body.name : ''
  try {
    if (!skills.remove(name)) {
      event.res.status = 404
      return { error: 'skill not found' }
    }
    return { ok: true, name }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
