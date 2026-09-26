import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister, listenParent } from 'dsh-tauri/client'
import { settings } from '../store/modules/settings'

export const SETTINGS_OPEN_MESSAGE = 'dsh://settings:open'

/**
 * 壳层 deep-link：宿主窗口 postMessage `dsh://settings:open`（`{ type, section }`，
 * section 可省略）→ 打开设置浮层并定位到对应分区。桌面壳的「管理机器」「同步到
 * 远端」等入口经此直达插件的设置分区，替代壳内重复管理面板。
 *
 * 消息体按宿主 → iframe 的既有约定平铺字段（同 `dsh://n` 的 `{ type,
 * sessionId }`），**不是** `{ payload: { section } }`——读错层级会让定位静默
 * 失效（浮层照开，但停在默认分区）。
 */
export const registerSettingsOpen = defineRegister<ClientContext>((controller) => {
  controller.add(listenParent((message) => {
    const section = message.section
    settings.openAt(typeof section === 'string' && section !== '' ? section : undefined)
  }, SETTINGS_OPEN_MESSAGE))
})
