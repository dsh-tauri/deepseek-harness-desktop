import { defineEventHandler } from 'h3'
import { skills } from '../../../service/skills'
import { rootView } from '../../../service/skills.utils'

export default defineEventHandler(async () => {
  return { roots: (await skills.listSources()).map(rootView) }
})
