/** 核心来源：local = 用户 CLI 安装；app = 桌面端预打包 */
export type CoreSource = 'local' | 'app'

/** Rust 侧 service::core::HarnessCore 的序列化形态（camelCase） */
export interface HarnessCore {
  /** `local` | `app`（无 tag 记录的旧激活行）| `app-<tag>` */
  id: string
  source: CoreSource
  /** 版本号（不含 v 前缀；缺失为空串） */
  version: string
  /** 完整 release tag（如 `dsh-0.1.0-rc.8-32331963388`；local 行为空串） */
  tag: string
  /** 核心入口（cli path）：本地核心为 bin.js，预打包为安装目录 */
  path: string
  /** 「打开目录」入口：本地核心为包目录，预打包为安装/槽位目录；未下载为空 */
  dir: string
  /** 本地是否可用（文件在盘/可解析） */
  present: boolean
  /** 当前是否使用中 */
  active: boolean
  /** 是否预览版（GitHub Pre-release label 或 tag 命名判定）：预览版不参与更新提示，仅列表展示 */
  preview: boolean
  /** 是否高于 resources/version-recommend.json 中的推荐版本 */
  aboveRecommended: boolean
  /** 本地存在但 pkg 仓库已不再提供的历史槽位 */
  orphaned: boolean
  /** 离线安装包随包分发的内置核心（resources/dsh）：固定置顶、标注「内置核心」且不可卸载 */
  bundled: boolean
  recommendedVersion: string | null
  error?: string | null
}
