import type { ClientContext } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../shared/constants'
import {
  PET_LOCALE_EFFECT,
  PET_MENU_EFFECT,
  PET_PREFILL_EFFECT,
  PET_SECTION_EFFECT,
} from './constants'
import { locale } from './locales'
import { petSectionFeature } from './register/pet-section'
import { prefillFeature } from './register/prefill'
import { settingsMenuFeature } from './register/settings-menu'

/** 插件显示名（诊断元数据）。 */
export const name = PLUGIN_ID

/** 需要的客户端服务：slots（槽位注册）、locale（双语文案）、sessions/workspaces（新建会话）。 */
export const inject = ['slots', 'locale', 'sessions', 'workspaces']

/** 插件体：安装文案，注册设置分区、设置菜单项与草稿注入（组件样式直接写在组件 className 上）。 */
export function apply(ctx: ClientContext): void {
  if (typeof window === 'undefined' || typeof document === 'undefined' || window.parent === window)
    return
  ctx.effect(locale.registerLocale, PET_LOCALE_EFFECT)
  ctx.effect(petSectionFeature, PET_SECTION_EFFECT)
  ctx.effect(settingsMenuFeature, PET_MENU_EFFECT)
  ctx.effect(prefillFeature, PET_PREFILL_EFFECT)
}
