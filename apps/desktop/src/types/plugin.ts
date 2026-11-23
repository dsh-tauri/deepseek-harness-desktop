/** Rust 侧 service::plugin::watch::PluginErrorInfo 的序列化形态（camelCase） */
export interface PluginErrorInfo {
  /** 错误消息（pnpm/运行日志片段） */
  message: string
  /** 记录动作：install / update / remove / runtime */
  action: string
  /** 记录时间（unix 秒级时间戳字符串） */
  at: string
}

/** Rust 侧 service::plugin::watch::DshPlugin 的序列化形态（camelCase） */
export interface DshPlugin {
  /** 依赖键（npm 包名），列表主键 */
  id: string
  /** 展示名：插件自身 package.json 的 name，缺失时回落预设清单 */
  name: string
  /** 已安装版本（解析失败时为空字符串） */
  version: string
  description: string
  /** 仓库地址（repository.url / homepage） */
  repo_url: string
  /** 是否在 dsh.profile.bundles 中（启动时自动加载） */
  bundled: boolean
  /** 插件开关状态：profile patch 的 disabled 覆盖，或 bundle 包被官方包级开关移出 bundles */
  disabled: boolean
  /** 预设清单中的「推荐」标记 */
  recommended: boolean
  /** 预设清单中的「修复」标记 */
  fix: boolean
  /** 预设清单中的「内置」标记（随包分发/本地热更新）：隐藏卸载入口并标注 [内置] */
  internal: boolean
  /** 是否有可用更新（由 `service::plugin::updates` 探测；未判定时为 false） */
  updateAvailable: boolean
  /** 判定得到的「最新版本」（registry latest / git HEAD SHA）；未判定时缺省 */
  latestVersion?: string
  /** 异常信息（安装/升级/卸载失败或页面运行期上报）；undefined = 正常 */
  error?: PluginErrorInfo | null
}

/** Rust 侧 service::plugin::patch_guard::QuarantinedPatchLayer 的序列化形态 */
export interface QuarantinedPatchLayer {
  /** 原始补丁文件路径（`$DSH_HOME/cordis.patch.yml` 或档案层的同名文件） */
  original: string
  /** 备份路径（`<原名>.broken-<UTC 时间戳>`）：修好语法后改回原名即可恢复 */
  backup: string
  /** 解析错误（serde_yaml 文本，含行列号） */
  error: string
}

/** Rust 侧 service::plugin::patch_guard::PatchQuarantineFailure 的序列化形态 */
export interface PatchQuarantineFailure {
  path: string
  error: string
}

/** Rust 侧 service::plugin::patch_guard::PatchQuarantineReport 的序列化形态 */
export interface PatchQuarantineReport {
  /** 已隔离（改名保存）的补丁层 */
  quarantined: QuarantinedPatchLayer[]
  /** 隔离失败的补丁层（只提示，不阻断其它层） */
  failures: PatchQuarantineFailure[]
}

/** Rust 侧 service::plugin::patch_entries::StrippedPatchLayer 的序列化形态 */
export interface StrippedPatchLayer {
  /** 原始补丁文件路径 */
  original: string
  /** 清理前的备份路径（`<原名>.bak-<UTC 时间戳>`） */
  backup: string
  /** 移除的悬空条目数 */
  removed: number
}

/** Rust 侧 service::plugin::patch_entries::PatchEntryStripReport 的序列化形态 */
export interface PatchEntryStripReport {
  /** 被清理过的补丁层（没有悬空条目时为空） */
  layers: StrippedPatchLayer[]
}

/** 迁移条目的兼容性判定结果（判定基准 = 当前核心版本） */
export type MigrationVerdict = 'compatible' | 'upgrade' | 'downgrade' | 'unknown'

/** Rust 侧 service::profile::migrate::MigrationEntry 的序列化形态 */
export interface MigrationEntry {
  /** 依赖键（npm 包名） */
  id: string
  /** 源档案已安装的版本 */
  version: string
  /** 实际用于安装的 spec（不兼容时带目标版本） */
  spec: string
  verdict: MigrationVerdict
  /** 升级/降级的建议版本；其余判定缺省 */
  targetVersion?: string
}

/** 档案级数据类别（Rust 侧 MigrationDataKind） */
export type MigrationDataKind = 'patch' | 'policy' | 'credentials'

/** Rust 侧 service::profile::migrate::MigrationDataItem 的序列化形态 */
export interface MigrationDataItem {
  kind: MigrationDataKind
  /** 条目数；凭据等无「条数」概念的一项缺省 */
  count?: number
  /** 目标档案已完全包含：迁移是空操作，界面禁用勾选 */
  covered: boolean
}

/** Rust 侧 service::profile::migrate::MigrationAnalysis 的序列化形态 */
export interface MigrationAnalysis {
  plugins: MigrationEntry[]
  /** 只有源档案里实际存在的数据项才会出现 */
  data: MigrationDataItem[]
}

/** Rust 侧 service::profile::migrate::MigrationFailure 的序列化形态 */
export interface MigrationFailure {
  kind: MigrationDataKind
  /** 失败原因（Rust 侧错误码，含大写前缀） */
  message: string
}

/** Rust 侧 service::profile::migrate::MigrateReport 的序列化形态 */
export interface MigrateReport {
  applied: MigrationDataKind[]
  /** 目标已有、按「目标优先」未改动的项 */
  skipped: MigrationDataKind[]
  failures: MigrationFailure[]
}
