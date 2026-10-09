import type { EventHandlerRequest } from 'h3'
import type { ActionResult, SkillPolicyBody } from '../../index.types'
import { defineEventHandler, readBody } from 'h3'
import { skills } from '../../../../service/skills'

export default defineEventHandler<EventHandlerRequest, Promise<ActionResult | { error: string }>>(async (event) => {
  const body = await readBody<SkillPolicyBody>(event, { type: 'json' })
  if (typeof body?.name !== 'string' || typeof body?.enabled !== 'boolean') {
    event.res.status = 400
    return { error: 'name and enabled are required' }
  }
  const name = body.name
  const enabled = body.enabled
  try {
    const definition = await skills.get(name)
    if (definition === null) {
      event.res.status = 404
      return { error: 'skill not found' }
    }
    if (definition.path === undefined) {
      event.res.status = 422
      return { error: 'skill has no file on disk (runtime-registered)' }
    }
    skills.setPolicy(definition.path, enabled)
    return { ok: true }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
