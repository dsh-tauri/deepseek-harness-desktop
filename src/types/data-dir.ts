/** Rust 侧 service::data_dir 的序列化形态（camelCase）。 */

/** 一个可回滚的旧目录备份：迁移时原目录被改名为 `<原名>.moved-<时间戳>`。 */
export interface MigrationBackup {
  path: string
  /** 目录名里的时间戳（yyyy-MM-ddTHH-mm-ss） */
  stamp: string
  /** 其中的会话数（备份价值的主要指标；为 0 时回滚后会话列表可能是空的） */
  sessions: number
}

/** 数据目录下的一个顶层子目录，附占用空间。 */
export interface DataDirEntry {
  name: string
  path: string
  files: number
  bytes: number
}

/** 迁移预检结果（目标合法性、体积、磁盘空间）。 */
export interface MigrationPlan {
  source: string
  target: string
  totalFiles: number
  totalBytes: number
  /** 需要重建的符号链接/联接数（复制时按链接重建，不跟随） */
  links: number
  /** 目标所在磁盘的可用字节（探测失败时为 0） */
  targetFreeBytes: number
  /** 可用空间是否够（含 5% 余量；探测失败按「够」处理） */
  enoughSpace: boolean
  /** 目标上级目录已存在 */
  parentExists: boolean
  /** 目标与上次迁移记录的位置一致（提示「回到旧位置」） */
  remembered: boolean
}

/** 迁移/回滚结果。 */
export interface MigrationOutcome {
  source: string
  target: string
  /** 旧位置：迁移时是改名后的备份目录，回滚时是「被挪到一边的当前目录」（空串表示无冲突） */
  movedTo: string
  files: number
  bytes: number
  links: number
  sessions: number
}

/** 进度事件 data-dir://progress 的载荷。 */
export interface DataDirProgress {
  operation: 'migrate' | 'rollback'
  /** 回滚只发 scan / finalize / done（不复制，因此没有 copy / verify） */
  phase: 'scan' | 'copy' | 'verify' | 'finalize' | 'done'
  copiedFiles: number
  copiedBytes: number
  totalFiles: number
  totalBytes: number
}

/** 当前数据目录状态；supported 为 false 时面板只展示说明、不展示任何动作。 */
export interface DataDirStatus {
  /** 仅 Windows 正式构建可迁移（debug 构建固定用 ~/.dsh.dev，忽略 DSH_HOME） */
  supported: boolean
  /** 当前生效的数据目录 */
  dataDir: string
  /** 未设置 DSH_HOME 时使用的默认目录（回滚目标可能是它） */
  defaultDir: string
  /** 用户级 DSH_HOME（未设置时为空字符串） */
  envOverride: string
  /** 最近一次迁移是否仍可回滚（旧目录还在） */
  rollbackAvailable: boolean
  /** 已发现的旧目录备份，按「会话数优先、时间戳其次」排序 */
  backups: MigrationBackup[]
  /** debug 构建：面板据此解释「为什么这里改不了」 */
  debugBuild: boolean
}
