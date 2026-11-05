import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { SkillsTab } from '../components/skills-tab'
import { SETTINGS_SECTION_SLOT, SKILLS_SECTION_ID, SKILLS_SECTION_ORDER } from '../constants'
import { locale } from '../locales'
import { store } from '../store'
import { chooseWorkspace, sessionSnapshotOf, workspaceSnapshotOf } from './skills-section.utils'

export const skillsSectionFeature = defineRegister<ClientContext>((controller, ctx, adapter) => {
  async function createSkill(): Promise<void> {
    const id = chooseWorkspace(
      sessionSnapshotOf(adapter.sessions.list?.getSnapshot()),
      workspaceSnapshotOf(adapter.workspaces.list?.getSnapshot()),
    )
    if (id === undefined)
      throw new Error(locale.text('workspaceUnavailable'))
    const sessionId = await adapter.workspaces.connectWorkspace?.(id)
    if (typeof sessionId !== 'string' || sessionId === '')
      throw new Error(locale.text('workspaceUnavailable'))
    store.prefill.add(sessionId)
    adapter.sessions.open?.(sessionId)
  }

  controller.add(ctx.slots.inject(SETTINGS_SECTION_SLOT as never, () => ctx.slots.register({
    name: SETTINGS_SECTION_SLOT,
    id: SKILLS_SECTION_ID,
    order: SKILLS_SECTION_ORDER,
    registrant: SKILLS_SECTION_ID,
    label: () => locale.text('skillsTab'),
    inject: () => ({ createSkill, t: locale.text }),
  } as never, SkillsTab)))
})
