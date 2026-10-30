import { PLUGIN_ID } from '../../shared/constants'

export { PLUGIN_ID }

/** 官方「通用」设置页里的条目 id（`settings.general.item` 槽位内唯一）。 */
export const SETTINGS_GENERAL_ITEM_ID = 'notification'

/** 条目顺序：夹在官方 `developer-tools`(15) 与 `current-version`(100) 之间。 */
export const SETTINGS_GENERAL_ITEM_ORDER = 30

/** 官方「通用」设置页的条目槽位名，由官方 `GeneralSection` 声明并渲染。 */
export const SETTINGS_GENERAL_ITEM_SLOT = 'settings.general.item'

/** 系统通知「批准」按钮的 action id，宿主窗口补丁原样回传该字符串。 */
export const APPROVE_ACTION_ID = 'approve'

/** 系统通知「拒绝」按钮的 action id。 */
export const REJECT_ACTION_ID = 'reject'

/** 系统通知「回复」按钮的 action id：按钮带输入框，用户输入即提问的答案。 */
export const REPLY_ACTION_ID = 'reply'

/** `ctx.effect` 的标签，便于在插件日志里定位。 */
export const LOCALE_EFFECT = `${PLUGIN_ID}: locale`
export const SETTINGS_EFFECT = `${PLUGIN_ID}: settings group`
export const NOTIFY_EFFECT = `${PLUGIN_ID}: notify`
