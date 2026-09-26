import { PLUGIN_ID } from '../../shared/constants'

export const SETTINGS_REGISTRANT = PLUGIN_ID
export const SETTINGS_SHELL_SEAT_ID = PLUGIN_ID

export const SETTINGS_SHELL_OVERLAY_SLOT = 'shell.overlay'
export const SETTINGS_SIDEBAR_SLOT = 'sidebar.settings'
export const HERO_WORKSPACE_SLOT = 'conversation.hero.workspace'
export const HERO_WORKSPACE_FLOW_SLOT = 'conversation.hero.workspace.directoryFlow'
export const SETTINGS_SECTION_SLOT = 'settings.section'
export const SETTINGS_TRIGGER_SLOT = 'settings.trigger'
export const SETTINGS_ONBOARDING_SLOT = 'settings.onboarding'

/**
 * 官方设定面板底部的启动器座位：官方 `ui-settings-general` 的 `SettingsRoot` 在此渲染账号菜单
 * （DeepSeek 官方登录入口），本插件以 `SETTINGS_TRIGGER_PRIORITY` 顶掉该条目后必须自行留位，
 * 否则官方账号 UI 注册了也没有宿主。
 */
export const SETTINGS_LAUNCHER_SLOT = 'settings.launcher'

export const SETTINGS_SIDEBAR_ID = 'dsh-tauri-ui-settings'
export const SETTINGS_SIDEBAR_CLASS = 'dshp-settings-sidebar'

/** 接管后的英雄区工作区选择控件（官方 chip 由样式隐藏，见 `ui/hero-workspace.cssr.ts`）。 */
export const HERO_WORKSPACE_CHIP_CLASS = 'dshp-hero-workspace'

/**
 * `conversation.hero.workspace` 是 single 槽：官方 `WorkspacePicker` 用默认 0 占位，同一 priority
 * 上再注册会直接抛错，按「最低者渲染」的排序用 -1 顶掉官方条目并接管该格。
 */
export const HERO_WORKSPACE_PRIORITY = -1

/**
 * 官方侧边栏「新建会话」按钮的 aria-label（中英双语，逐字取自官方 sidebar 词典）。
 *
 * 品牌按钮与工具栏按钮共用这一条文案；官方工作区分组行的「+」用的是带工作区名字的另一条
 * （`在“{name}”中新建会话` / `New session in {name}`），因此分组行的行为不受拦截影响。
 */
export const NEW_SESSION_LABELS = ['新建会话', 'New session'] as const

/**
 * 官方「未分组」分组行「+」的 aria-label（中英双语，逐字取自官方 ui-workspace 词典的
 * `actions.newSession.aria` 与 `group.ungrouped` 组合）。
 *
 * 0.1.7 起分组行带 `data-row-key`，优先按行键判定；此文案只作为 ≤0.1.6 的退化判据。
 */
export const UNGROUPED_NEW_SESSION_LABELS = ['在“未分组”中新建会话', 'New session in Ungrouped'] as const

/** 官方未分组分组行的行键：`workspace:` + 官方 `UNGROUPED_KEY`（后者为空串）。 */
export const UNGROUPED_ROW_KEY = 'workspace:'

/** dsh-im 客户端插件经 `ctx.provide` 发布的反射服务名（4.22.0 起）。 */
export const DSH_IM_CLIENT_SERVICE = 'dshImClient'

/**
 * 折叠粘贴的引用源名：既是官方引用注册表里的唯一键，也是官方 chip 宿主元素写的
 * `data-composer-chip` 值（C 浏览器层的断言锚点）。
 */
export const PASTE_CHIP_SOURCE = `${PLUGIN_ID}-paste`

export const STYLES_EFFECT = `${PLUGIN_ID}: styles`
export const LOCALE_EFFECT = `${PLUGIN_ID}: locale`
export const SEAT_EFFECT = `${PLUGIN_ID}: shell.overlay seat`
export const SECTIONS_EFFECT = `${PLUGIN_ID}: settings sections projection`
export const SETTINGS_EFFECT = `${PLUGIN_ID}: settings panel`
export const OBSTRUCTIONS_EFFECT = `${PLUGIN_ID}: settings obstructions`
export const SETTINGS_OPEN_EFFECT = `${PLUGIN_ID}: settings deep-link`
export const IM_PANEL_EFFECT = `${PLUGIN_ID}: im panel`
export const HERO_WORKSPACE_EFFECT = `${PLUGIN_ID}: hero workspace picker`
export const NEW_SESSION_EFFECT = `${PLUGIN_ID}: sidebar new session`
export const UNGROUPED_NEW_SESSION_EFFECT = `${PLUGIN_ID}: sidebar ungrouped new session`
export const PASTE_COLLAPSE_EFFECT = `${PLUGIN_ID}: paste collapse`

export const TURN_NAVIGATION_LABEL_ZH = '轮次导航'
export const TURN_NAVIGATION_LABEL_EN = 'Turn navigation'
export const TURN_NAVIGATION_SELECTOR = `:is(nav[aria-label="${TURN_NAVIGATION_LABEL_ZH}"], nav[aria-label="${TURN_NAVIGATION_LABEL_EN}"])`
export const TURN_NAVIGATION_SLOT_SELECTOR = `div:has(> ${TURN_NAVIGATION_SELECTOR})`

export const SETTINGS_TRIGGER_PRIORITY = -1

export const SETTINGS_UNDERLAY_SLOT_KEYS = ['sidebar', 'main', 'rightbar'] as const
export const SETTINGS_EXTERNAL_OVERLAY_SELECTORS = ['[data-dsh-better-sidebar]', '[data-dsh-panel]'] as const
export const SIDEBAR_WIDTH_PROPERTY = '--dsh-sidebar-width'

export const RAIL_WIDTH_MIN = 264
export const RAIL_WIDTH_MAX = 420
export const RAIL_WIDTH_DEFAULT = 280
