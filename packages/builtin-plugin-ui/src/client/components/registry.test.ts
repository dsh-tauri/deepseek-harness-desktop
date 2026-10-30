import { describe, expect, it } from 'vitest'
import { UI_COMPONENT_REGISTRY } from './registry'

const reforks = [
  ['Checkbox', 'default', 'ui-primitives', '0.1.7-rc.2', 'ui-primitives/src/Checkbox.tsx', 'checkbox'],
  ['StateDot', 'dot', 'ui-primitives', '0.1.7-rc.2', 'ui-primitives/src/StateDot.module.css', 'dot'],
  ['Button', 'elevated', 'ui-sidebar', 'both', 'ui-sidebar/src/client/SidebarRoot.module.css', 'newSession'],
  ['Button', 'add', 'ui-plugin-manager', '0.1.7-rc.2', 'ui-plugin-manager/src/client/PluginManagerPage.module.css', 'addButton'],
  ['Button', 'addGhost', 'ui-plugin-manager', '0.1.7-rc.2', 'ui-plugin-manager/src/client/PluginManagerPage.module.css', 'addButton'],
  ['Button', 'danger', 'ui-plugin-manager', '0.1.7-rc.2', 'ui-plugin-manager/src/client/PluginManagerPage.module.css', 'danger'],
  ['Action', 'search', 'ui-workspace', 'both', 'ui-workspace/src/client/rows/WorkspaceBrowser.module.css', 'searchButton'],
  ['Action', 'toolbar', 'ui-plugin-manager', '0.1.7-rc.2', 'ui-plugin-manager/src/client/PluginManagerPage.module.css', 'iconButton'],
  ['Action', 'model', 'ui-settings-models', 'both', 'ui-settings-models/src/client/ModelsSection.module.css', 'iconButton'],
  ['Action', 'round', 'ui-sidebar', 'both', 'ui-sidebar/src/client/SidebarRoot.module.css', 'iconButton'],
  ['Action', 'row', 'ui-workspace', 'both', 'ui-workspace/src/client/rows/Rows.module.css', 'iconButton'],
  ['Action', 'help', 'ui-primitives', '0.1.7-rc.2', 'ui-primitives/src/settings-form/fields.module.css', 'helpButton'],
  ['Action', 'action', 'ui-chat', 'both', 'ui-chat/src/client/chat/MessageIconActions.module.css', 'action'],
  ['Chip', 'seat', 'ui-agent-preset', 'both', 'ui-agent-preset/src/client/AgentPresetSeat.module.css', 'seat'],
  ['Chip', 'composerTrigger', 'ui-permission-presets', '0.1.7-rc.2', 'ui-permission-presets/src/client/PermissionSelect.module.css', 'trigger'],
  ['Chip', 'selector', 'ui-permission-presets', 'both', 'ui-permission-presets/src/client/PermissionRow.module.css', 'selector'],
  ['ConversationBar', 'bar', 'ui-goal', 'both', 'ui-goal/src/client/GoalBar.module.css', 'bar'],
  ['ConversationBar', 'action', 'ui-goal', 'both', 'ui-goal/src/client/GoalBar.module.css', 'iconBtn'],
  ['Tag', 'version', 'ui-plugin-manager', '0.1.7-rc.2', 'ui-plugin-manager/src/client/PluginManagerPage.module.css', 'versionTag'],
  ['Tag', 'status', 'ui-plugin-manager', '0.1.7-rc.2', 'ui-plugin-manager/src/client/PluginManagerPage.module.css', 'statusTag'],
]

describe('ui component registry', () => {
  it('preserves the refork ordering and upstream metadata', () => {
    const rows = UI_COMPONENT_REGISTRY.filter(entry => entry.source.kind === 'refork')
    expect(rows.map(({ source }) => [
      source.component,
      source.variant,
      source.package.replace('@deepseek-ai/dsh-client-', ''),
      source.availableAt.length === 2 ? 'both' : source.availableAt[0],
      source.upstreamPath.replace('packages/client/', ''),
      source.mappedClass,
    ])).toEqual(reforks)
    expect(rows.every(entry => entry.source.version === '0.1.7-rc.2')).toBe(true)
    expect(rows.map(entry => entry.id)).toEqual([
      'checkbox-default',
      'state-dot-dot',
      'button-elevated',
      'button-add',
      'button-add-ghost',
      'button-danger',
      'action-search',
      'action-toolbar',
      'action-model',
      'action-round',
      'action-row',
      'action-help',
      'action-action',
      'chip-seat',
      'chip-composer-trigger',
      'chip-selector',
      'conversation-bar-bar',
      'conversation-bar-action',
      'tag-version',
      'tag-status',
    ])
    expect(UI_COMPONENT_REGISTRY).toHaveLength(48)
  })
})
