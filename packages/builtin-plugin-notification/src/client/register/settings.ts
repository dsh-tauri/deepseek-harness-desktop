import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'
import { NotificationSettingsGroup } from '../components/settings-group'
import { SETTINGS_GENERAL_ITEM_ID, SETTINGS_GENERAL_ITEM_ORDER, SETTINGS_GENERAL_ITEM_SLOT } from '../constants'
import { locale } from '../locales'

/**
 * 把通知设置挂进官方「通用」设置页的 `settings.general.item` 槽位。
 *
 * 这个子槽位由官方 `GeneralSection` 声明并渲染（`renderSlot("settings.general.item")`），
 * 所以本包只贡献条目内容、不画页面骨架，也不进左侧导航——条目不带 `label`。
 *
 * 槽位名与组件都用 `as never` 收窄：槽位表由官方 UI 包做声明合并，
 * 本包不依赖它们的类型（与 `dsh-tauri-pet` 的做法一致）。
 */
export const settingsFeature = defineRegister<ClientContext>((controller, ctx) => {
  controller.add(ctx.slots.inject(SETTINGS_GENERAL_ITEM_SLOT as never, () => ctx.slots.register({
    name: SETTINGS_GENERAL_ITEM_SLOT,
    id: SETTINGS_GENERAL_ITEM_ID,
    order: SETTINGS_GENERAL_ITEM_ORDER,
    registrant: PLUGIN_ID,
    locale: locale.NS,
    inject: () => ({}),
  } as never, NotificationSettingsGroup as never)))
})
