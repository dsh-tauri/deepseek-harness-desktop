/** Rust 侧 service::deps_root 的序列化形态（camelCase）。 */

/** 依赖根状态：dsh / pnpm / git 运行时装在哪。 */
export interface DependenciesRootStatus {
  /** 当前生效的依赖根 */
  root: string
  /** 未自定义时使用的位置（AppData 下的 dependencies） */
  defaultRoot: string
  /** 是否已被用户自定义 */
  custom: boolean
  /** 能否迁移：随包资源根与本地核心不是桌面端下载产物 */
  movable: boolean
}

/** 迁移预检：体积与目标磁盘空间。 */
export interface DependenciesRootPreview {
  source: string
  target: string
  totalFiles: number
  totalBytes: number
  /** 目标所在磁盘的可用字节（探测失败时为 0） */
  targetFreeBytes: number
  /** 可用空间是否够（含 5% 余量；探测失败按「够」处理） */
  enoughSpace: boolean
}

/** 迁移结果。 */
export interface DependenciesMigrationOutcome {
  source: string
  target: string
  /** 旧根改名后的备份目录（空串表示旧根本就是空的、已直接删掉） */
  movedTo: string
  files: number
  bytes: number
}

/** 进度事件 deps-root://progress 的载荷（phase 与 data-dir://progress 同口径）。 */
export interface DependenciesRootProgress {
  operation: 'deps-root'
  phase: 'scan' | 'copy' | 'verify' | 'finalize' | 'done'
  copiedFiles: number
  copiedBytes: number
  totalFiles: number
  totalBytes: number
}
