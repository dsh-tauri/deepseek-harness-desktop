import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { McpTab } from '../components/mcp-tab'
import { MCP_SECTION_ID, MCP_SECTION_ORDER, SETTINGS_SECTION_SLOT } from '../constants'
import { locale } from '../locales'

export const mcpSectionFeature = defineRegister<ClientContext>((controller, ctx) => {
  controller.add(ctx.slots.inject(SETTINGS_SECTION_SLOT as never, () => ctx.slots.register({
    name: SETTINGS_SECTION_SLOT,
    id: MCP_SECTION_ID,
    order: MCP_SECTION_ORDER,
    registrant: MCP_SECTION_ID,
    label: () => locale.text('mcpTab'),
    inject: () => ({ t: locale.text }),
  } as never, McpTab)))
})
