import type { EventHandlerRequest } from 'h3'
import type { ActionResult, SkillOpenBody } from '../../index.types'
import { mkdirSync } from 'node:fs'
import { defineEventHandler, readBody } from 'h3'
import { SKILLS_DATA_DIR } from '../../../../config/constants'
import { opener } from '../../../../service/opener'
import { skills } from '../../../../service/skills'

const SKILL_FILE_PATTERN = /[/\\]SKILL\.md$/

const SKILL_DOCUMENT_PATTERN = /[/\\][^/\\]+\.md$/

export default defineEventHandler<EventHandlerRequest, Promise<ActionResult | { error: string }>>(async (event) => {
  const body = await readBody<SkillOpenBody>(event, { type: 'json' })
  if (typeof body?.target !== 'string') {
    event.res.status = 400
    return { error: 'target is required' }
  }
  try {
    let dir: string | undefined
    if (body.target === 'user-skills' || body.target === 'plugin-state') {
      dir = SKILLS_DATA_DIR
      mkdirSync(dir, { recursive: true })
    }
    else if (body.target === 'skill') {
      if (typeof body.name !== 'string') {
        event.res.status = 400
        return { error: 'name is required' }
      }
      const definition = await skills.get(body.name)
      if (definition === null) {
        event.res.status = 404
        return { error: 'skill not found' }
      }
      dir = definition.path !== undefined
        ? definition.path.replace(SKILL_FILE_PATTERN, '').replace(SKILL_DOCUMENT_PATTERN, '')
        : definition.resourceBase?.kind === 'directory' ? definition.resourceBase.path : undefined
    }
    else if (body.target === 'root') {
      if (typeof body.id !== 'string') {
        event.res.status = 400
        return { error: 'id is required' }
      }
      const entry = (await skills.listSources()).find(row => row.id === body.id)
      if (entry === undefined) {
        event.res.status = 404
        return { error: 'repository not found' }
      }
      dir = entry.materialDir ?? entry.path ?? entry.roots[0]
    }
    else {
      event.res.status = 400
      return { error: 'unknown target' }
    }
    if (dir === undefined || !opener.open(dir)) {
      event.res.status = 422
      return { error: 'directory is not available on disk' }
    }
    return { ok: true }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
