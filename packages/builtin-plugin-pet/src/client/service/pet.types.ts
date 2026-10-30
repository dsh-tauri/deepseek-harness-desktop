/** 桌宠领域动作的统一结果（Action 原型）。 */
export type PetActionResult = { ok: true } | { ok: false, error: string }

/** DTO：桌面端 Tauri 命令的请求/响应形状（invoke 层专属）。 */

export interface PetStatus {
  active_pet: string
  enabled: boolean
  pet_size?: number | null
  /** 是否允许抛射（默认关闭，issue #930）。 */
  throw_enabled: boolean
  visible: boolean
}

export type PetSource = 'chat' | 'codex'

export interface PetListItem {
  description?: string
  id: string
  name: string
  source: PetSource
  kind?: 'dsh' | 'codex'
  thumbnail?: string
  thumbnail_type?: 'gif' | 'spritesheet'
}

/**
 * 预设宠物清单条目（`resources/manifest.jsonc` 的 `pets.built-in` 展示层投影）。
 *
 * 预设不下载/安装：清单条目本身就是桌宠组件的渲染参数，设置页只需要展示字段，
 * 因此这里只声明投影形状，Rust 返回的其余字段前端原样忽略。
 */
export interface PresetPetItem {
  desc?: string | null
  id: string
  image?: string | null
  kind?: 'dsh' | 'codex' | null
  name: string
  /** 是否由用户登记远端资源；内置预设为 false，只有登记来的条目可删除。 */
  remote?: boolean
  size?: number | null
}
