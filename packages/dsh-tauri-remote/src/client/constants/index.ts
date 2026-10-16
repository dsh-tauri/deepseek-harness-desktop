import { REMOTE_PLUGIN_NAME as PLUGIN_ID } from '../../shared/constants'

export { REMOTE_PLUGIN_NAME as PLUGIN_ID } from '../../shared/constants'

export const SETTINGS_SECTION_SLOT = 'settings.section'
export const SETTINGS_SECTION_ID = PLUGIN_ID
/**
 * 分区顺序 50：排在核心分区（通用设置/模型/内置插件/Agent 预设）之后、其它插件分区之前。
 * 不能取更小值：移动端设置弹窗以「首个分区」作为首屏详情页，语言切换项在通用设置里，
 * 我们的分区一旦排最前，移动端首屏就会落到远程访问，`dsh-tauri-mobile-settings` 契约随之失败。
 */
export const SETTINGS_SECTION_ORDER = 50

export const REMOTE_TAB_MACHINES = 'machines'
export const REMOTE_TAB_SYNC = 'sync'
export const REMOTE_TAB_ACCESS = 'access'
export const REMOTE_TABS_ID = 'dsh-tauri-remote-tabs'
export const SETTINGS_OPEN_MESSAGE = 'dsh://settings:open'

export const REMOTE_BRIDGE_PING_COMMAND = 'remote_bridge_ping'
export const REMOTE_OPEN_WINDOW_COMMAND = 'remote_open_window'

export const LOCALE_EFFECT = `${PLUGIN_ID}: locale`
export const SECTION_EFFECT = `${PLUGIN_ID}: settings section`
export const POLL_EFFECT = `${PLUGIN_ID}: machine polling`
