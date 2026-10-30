export interface UiComponentSource {
  kind: 'reexport' | 'refork'
  component: string
  variant?: string
  package: string
  version: string
  availableAt: readonly string[]
  upstreamPath: string
  mappedClass?: string
}

export interface UiComponentEntry {
  id: string
  title: string
  source: UiComponentSource
}

const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'
const VERSION = '0.1.7-rc.2'
const AVAILABLE_BOTH = ['0.1.5-rc.1', '0.1.7-rc.2']
const AVAILABLE_LATEST = ['0.1.7-rc.2']

function slug(name: string): string {
  return name.replaceAll('_', '-').replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

function primitives(component: string, file: string): UiComponentEntry {
  return {
    id: slug(component),
    title: component,
    source: {
      kind: 'reexport',
      component,
      package: PRIMITIVES,
      version: VERSION,
      availableAt: AVAILABLE_BOTH,
      upstreamPath: `packages/client/ui-primitives/src/${file}.tsx`,
    },
  }
}

function reforkVariant(
  component: string,
  variant: string,
  packageName: string,
  availableAt: readonly string[],
  upstreamPath: string,
  mappedClass: string,
): UiComponentEntry {
  return {
    id: `${slug(component)}-${slug(variant)}`,
    title: `${component} · ${variant}`,
    source: {
      kind: 'refork',
      component,
      variant,
      version: VERSION,
      package: packageName,
      availableAt,
      upstreamPath,
      mappedClass,
    },
  }
}

export const UI_COMPONENT_REGISTRY: readonly UiComponentEntry[] = [
  primitives('Button', 'Button'),
  primitives('ButtonVariant', 'Button'),
  primitives('Switch', 'Switch'),
  primitives('Tag', 'Tag'),
  primitives('TagTone', 'Tag'),
  primitives('Pill', 'Pill'),
  primitives('Menu', 'Menu'),
  primitives('MenuEntry', 'Menu'),
  primitives('MenuItem', 'Menu'),
  primitives('MenuLabel', 'Menu'),
  primitives('MenuSeparator', 'Menu'),
  primitives('Input', 'Input'),
  primitives('Tooltip', 'Tooltip'),
  primitives('TooltipSide', 'Tooltip'),
  primitives('Toast', 'Toast'),
  primitives('Modal', 'Modal'),
  primitives('HoverCard', 'HoverCard'),
  primitives('DisclosureRow', 'DisclosureRow'),
  primitives('DisclosureRowProps', 'DisclosureRow'),
  primitives('StateDot', 'StateDot'),
  primitives('StateDotState', 'StateDot'),
  primitives('ConnectionIndicator', 'ConnectionIndicator'),
  primitives('ConnectionIndicatorState', 'ConnectionIndicator'),
  primitives('BrandWordmark', 'BrandWordmark'),
  primitives('BrandWordmarkProps', 'BrandWordmark'),
  primitives('FishLogo', 'FishLogo'),
  primitives('FISH_LOGO_PATH', 'FishLogo'),
  primitives('FISH_LOGO_VIEWBOX', 'FishLogo'),

  reforkVariant('Checkbox', 'default', PRIMITIVES, AVAILABLE_LATEST, 'packages/client/ui-primitives/src/Checkbox.tsx', 'checkbox'),
  reforkVariant('StateDot', 'dot', PRIMITIVES, AVAILABLE_LATEST, 'packages/client/ui-primitives/src/StateDot.module.css', 'dot'),
  reforkVariant('Button', 'elevated', '@deepseek-ai/dsh-client-ui-sidebar', AVAILABLE_BOTH, 'packages/client/ui-sidebar/src/client/SidebarRoot.module.css', 'newSession'),
  reforkVariant('Button', 'add', '@deepseek-ai/dsh-client-ui-plugin-manager', AVAILABLE_LATEST, 'packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css', 'addButton'),
  reforkVariant('Button', 'addGhost', '@deepseek-ai/dsh-client-ui-plugin-manager', AVAILABLE_LATEST, 'packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css', 'addButton'),
  reforkVariant('Button', 'danger', '@deepseek-ai/dsh-client-ui-plugin-manager', AVAILABLE_LATEST, 'packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css', 'danger'),
  reforkVariant('Action', 'search', '@deepseek-ai/dsh-client-ui-workspace', AVAILABLE_BOTH, 'packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.module.css', 'searchButton'),
  reforkVariant('Action', 'toolbar', '@deepseek-ai/dsh-client-ui-plugin-manager', AVAILABLE_LATEST, 'packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css', 'iconButton'),
  reforkVariant('Action', 'model', '@deepseek-ai/dsh-client-ui-settings-models', AVAILABLE_BOTH, 'packages/client/ui-settings-models/src/client/ModelsSection.module.css', 'iconButton'),
  reforkVariant('Action', 'round', '@deepseek-ai/dsh-client-ui-sidebar', AVAILABLE_BOTH, 'packages/client/ui-sidebar/src/client/SidebarRoot.module.css', 'iconButton'),
  reforkVariant('Action', 'row', '@deepseek-ai/dsh-client-ui-workspace', AVAILABLE_BOTH, 'packages/client/ui-workspace/src/client/rows/Rows.module.css', 'iconButton'),
  reforkVariant('Action', 'help', PRIMITIVES, AVAILABLE_LATEST, 'packages/client/ui-primitives/src/settings-form/fields.module.css', 'helpButton'),
  reforkVariant('Action', 'action', '@deepseek-ai/dsh-client-ui-chat', AVAILABLE_BOTH, 'packages/client/ui-chat/src/client/chat/MessageIconActions.module.css', 'action'),
  reforkVariant('Chip', 'seat', '@deepseek-ai/dsh-client-ui-agent-preset', AVAILABLE_BOTH, 'packages/client/ui-agent-preset/src/client/AgentPresetSeat.module.css', 'seat'),
  reforkVariant('Chip', 'composerTrigger', '@deepseek-ai/dsh-client-ui-permission-presets', AVAILABLE_LATEST, 'packages/client/ui-permission-presets/src/client/PermissionSelect.module.css', 'trigger'),
  reforkVariant('Chip', 'selector', '@deepseek-ai/dsh-client-ui-permission-presets', AVAILABLE_BOTH, 'packages/client/ui-permission-presets/src/client/PermissionRow.module.css', 'selector'),
  reforkVariant('ConversationBar', 'bar', '@deepseek-ai/dsh-client-ui-goal', AVAILABLE_BOTH, 'packages/client/ui-goal/src/client/GoalBar.module.css', 'bar'),
  reforkVariant('ConversationBar', 'action', '@deepseek-ai/dsh-client-ui-goal', AVAILABLE_BOTH, 'packages/client/ui-goal/src/client/GoalBar.module.css', 'iconBtn'),
  reforkVariant('Tag', 'version', '@deepseek-ai/dsh-client-ui-plugin-manager', AVAILABLE_LATEST, 'packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css', 'versionTag'),
  reforkVariant('Tag', 'status', '@deepseek-ai/dsh-client-ui-plugin-manager', AVAILABLE_LATEST, 'packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css', 'statusTag'),
]
