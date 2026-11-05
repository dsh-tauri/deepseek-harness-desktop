import type { LifecycleController } from '../../../../builtin-plugin-tauri/src/client/controller'
import { beforeEach, expect, it, vi } from 'vitest'
import { createLifecycleController } from '../../../../builtin-plugin-tauri/src/client/controller'
import { MCP_SECTION_ID, SKILLS_SECTION_ID, SKILLS_SECTION_ORDER } from '../constants'
import { mcpSectionFeature } from './mcp-section'
import { skillsSectionFeature } from './skills-section'

const mocks = vi.hoisted(() => ({
  prefillAdd: vi.fn(),
  connectWorkspace: vi.fn(async () => 'session-created'),
  openSession: vi.fn(),
}))

vi.mock('dsh-tauri/client', () => ({ defineRegister: (setup: unknown) => setup }))
vi.mock('../locales', () => ({ locale: { text: (key: string) => key } }))
vi.mock('../store', () => ({ store: { prefill: { add: mocks.prefillAdd } } }))
vi.mock('../components/mcp-tab', () => ({ McpTab: () => null }))
vi.mock('../components/skills-tab', () => ({ SkillsTab: () => null }))

interface Registration { options: Record<string, unknown>, component: unknown }

function host(entries: Registration[]): unknown {
  return {
    slots: {
      inject: (_name: string, run: () => () => void) => run(),
      register: (options: Record<string, unknown>, component: unknown) => {
        entries.push({ options, component })
        return () => {
          entries.splice(entries.findIndex(entry => entry.options === options), 1)
        }
      },
    },
  }
}

function adapterOf(items: Array<Record<string, unknown>>): unknown {
  return {
    service: () => undefined,
    sessions: { list: { getSnapshot: () => ({ ids: ['session-1'], current: 'session-1' }) }, open: mocks.openSession },
    workspaces: {
      list: { getSnapshot: () => ({ items }) },
      connectWorkspace: mocks.connectWorkspace,
    },
  }
}

function run(feature: unknown, ctx: unknown, adapter: unknown): LifecycleController {
  const controller = createLifecycleController()
  ;(feature as (c: LifecycleController, ctx: unknown, adapter: unknown) => void)(controller, ctx, adapter)
  return controller
}

function injectOf(entry: Registration): Record<string, unknown> {
  return (entry.options.inject as () => Record<string, unknown>)()
}

beforeEach(() => {
  vi.clearAllMocks()
})

it('registers skills and MCP as settings sections and cleans both up', () => {
  const skillEntries: Registration[] = []
  const mcpEntries: Registration[] = []
  const skillsController = run(skillsSectionFeature, host(skillEntries), adapterOf([]))
  const mcpController = run(mcpSectionFeature, host(mcpEntries), adapterOf([]))
  try {
    expect(skillEntries[0].options).toMatchObject({
      name: 'settings.section',
      id: SKILLS_SECTION_ID,
      order: SKILLS_SECTION_ORDER,
      registrant: SKILLS_SECTION_ID,
    })
    expect((skillEntries[0].options.label as () => string)()).toBe('skillsTab')
    expect(injectOf(skillEntries[0]).t).toBeTypeOf('function')
    expect(mcpEntries[0].options).toMatchObject({
      name: 'settings.section',
      id: MCP_SECTION_ID,
      registrant: MCP_SECTION_ID,
    })
    expect((mcpEntries[0].options.label as () => string)()).toBe('mcpTab')
    expect(injectOf(mcpEntries[0]).t).toBeTypeOf('function')
  }
  finally {
    skillsController.dispose()
    mcpController.dispose()
  }
  expect(skillEntries).toHaveLength(0)
  expect(mcpEntries).toHaveLength(0)
})

it('starts the skill creator in the current workspace', async () => {
  const entries: Registration[] = []
  const controller = run(skillsSectionFeature, host(entries), adapterOf([{ workspaceId: 'workspace-1', sessionIds: ['session-1'] }]))
  try {
    await (injectOf(entries[0]).createSkill as () => Promise<void>)()
    expect(mocks.connectWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-1')
    expect(mocks.prefillAdd).toHaveBeenCalledExactlyOnceWith('session-created')
    expect(mocks.openSession).toHaveBeenCalledExactlyOnceWith('session-created')
  }
  finally {
    controller.dispose()
  }
})

it('refuses the skill creator when no workspace is catalogued', async () => {
  const entries: Registration[] = []
  const controller = run(skillsSectionFeature, host(entries), adapterOf([]))
  try {
    await expect((injectOf(entries[0]).createSkill as () => Promise<void>)()).rejects.toThrow('workspaceUnavailable')
    expect(mocks.connectWorkspace).not.toHaveBeenCalled()
  }
  finally {
    controller.dispose()
  }
})
