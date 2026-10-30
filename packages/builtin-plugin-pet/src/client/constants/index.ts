import { PLUGIN_ID } from '../../shared/constants'

/** settings.section 槽位里的桌宠分区标识与排序权重。 */
export const PET_SECTION_ID = 'dsh-tauri-pet-settings'
export const PET_SECTION_ORDER = 210

/** effect 标签。 */
export const PET_LOCALE_EFFECT = `${PLUGIN_ID}: locale`
export const PET_SECTION_EFFECT = `${PLUGIN_ID}: settings section`
export const PET_PREFILL_EFFECT = `${PLUGIN_ID}: conversation prefill`
export const PET_MENU_EFFECT = `${PLUGIN_ID}: settings menu items`

/** conversation.input.left 槽位里的一次性草稿注入。 */
export const CONVERSATION_INPUT_LEFT_SLOT = 'conversation.input.left'
export const PET_PREFILL_ID = 'dsh-tauri-pet-prefill'
export const PET_PREFILL_ORDER = 230
export const PET_PREFILL_PRIORITY = 0
export const PET_HATCH_PROMPT = '/hatch-dsh-pet 根据你对我的了解，养一只宠物'

/** 桌面端 Tauri 命令 id（与 src-tauri 的 command 名逐字一致）。 */
export const CMD_GET_PET_STATUS = 'get_pet_status'
export const CMD_GET_PET_OVERLAY_SUPPORTED = 'get_pet_overlay_supported'
export const CMD_GET_FORCE_XWAYLAND = 'get_force_xwayland'
export const CMD_SET_FORCE_XWAYLAND = 'set_force_xwayland'
export const CMD_SET_PET_ENABLED = 'set_pet_enabled'
export const CMD_SET_ACTIVE_PET = 'set_active_pet'
export const CMD_SET_PET_SIZE = 'set_pet_size'
export const CMD_SET_PET_THROW_ENABLED = 'set_pet_throw_enabled'
export const CMD_LIST_PETS = 'list_pets'
export const CMD_IMPORT_PET = 'import_pet'
export const CMD_DELETE_PET = 'delete_pet'
export const CMD_IMPORT_PET_REPOSITORY = 'import_pet_repository'
export const CMD_CHECK_PET_UPDATES = 'check_pet_updates'
export const CMD_UPDATE_PET_REPOSITORY = 'update_pet_repository'
export const CMD_LIST_PRESET_PETS = 'list_preset_pets'
export const CMD_OPEN_EXTERNAL_URL = 'open_external_url'

/** Codex 宠物社区站点（「社区分享」按钮的目标地址）。 */
export const PET_COMMUNITY_URL = 'https://codex-pets.net/#/'

/**
 * 设置菜单补丁的选择器与守卫属性。
 *
 * 官方账号菜单（桌面载体）与壳层自有菜单（浏览器直开）都是官方 primitives 的 portal `Menu`，
 * 条目为 `button[role=menuitem]`，结构为 `itemIcon` + `itemLabel`（+ 可选 `shortcut` 键帽）；
 * 「设置」条目是唯一锚点，其它菜单（工作区、模型选择等）不含该文案。克隆官方条目以继承样式，
 * 因此不依赖动态类名哈希。
 *
 * 桌宠的开关只存在于这个菜单里：侧栏爪按钮已删除（设置入口两种形态都是菜单）。
 */
export const SETTINGS_MENU_LABELS: readonly string[] = ['设置', 'Settings']
export const MENU_ITEM_SELECTOR = 'button[role="menuitem"]'
export const MENU_ITEM_LABEL_SELECTOR = '[class*="itemLabel"]'
export const MENU_ITEM_ICON_SELECTOR = '[class*="itemIcon"]'
export const MENU_ITEM_SHORTCUT_SELECTOR = '[class*="shortcut"]'
export const PET_MENU_ITEM_ATTRIBUTE = 'data-dsh-tauri-pet-menu-item'
export const PET_MENU_PATCH_ATTRIBUTE = 'data-dsh-tauri-pet-menu-patched'

/** 桌宠窗口大小（百分比）。 */
export const PET_DEFAULT_SIZE = 100
export const PET_SIZE_MIN = 50
export const PET_SIZE_MAX = 200
export const PET_SIZE_STEP = 5
