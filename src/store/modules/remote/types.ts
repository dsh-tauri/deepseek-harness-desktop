/**
 * SSH 远端机器的类型面：壳层消费 `/api-ssh`（本地实例上的 dsh-tauri-ssh
 * 插件路由）所需的最小机器行词汇。字段与插件 host 侧
 * `SshMachineListItem`（C-STATE / S1 契约）逐字对齐：六态连接状态 +
 * `nextRetryAt`/`authMethod` 增量、隧道 URL、最近错误与机器标识色。
 * @module store/remote/types
 */

/** S3 状态词汇表（六态）：切换器状态点与切换语义的共用词汇。 */
export type SshConnectionState
  = | 'disconnected'
    | 'testing'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'given-up'

/** 切换器渲染所需的机器行（`machine.list` 行的壳层投影）。 */
export interface SshMachineRow {
  id: string
  name: string
  /** 标识色（手动机器可选）；色点优先取它。 */
  color?: string
  /** 是否用标识色给内容区描边。 */
  tintBorder?: boolean
  /** 连接目标（管理面板表单回填与切换器副标题）。 */
  host?: string
  port?: number
  user?: string
  /** 远端 dsh web 端口。 */
  remotePort?: number
  /** 自定义启动命令（远端 home pin 端口时用）。 */
  startCommand?: string
  /** 是否已存密码/密钥口令（值本身永不过线；表单「留空=保留」提示用）。 */
  hasPassword?: boolean
  hasPassphrase?: boolean
  state: SshConnectionState
  /** 隧道就绪时的本地回环 URL（`http://127.0.0.1:<port>`）。 */
  tunnelBaseUrl?: string
  /** 最近一次失败的原因（given-up 时呈现入口）。 */
  lastError?: string
  /** 下次重连重试时间（epoch ms，reconnecting 时出现）。 */
  nextRetryAt?: number
  /** 当前（或最近一次成功）连接使用的凭据类型。 */
  authMethod?: 'agent' | 'key' | 'password'
  /** 进行中操作的实时阶段（连接/安装管线），落定即消失。 */
  progress?: SshProgress
}

/** 连接管线阶段（宿主 progress.phase 词汇；installing 含 bootstrap 安装段）。 */
export type SshProgressPhase = 'handshake' | 'installing' | 'starting' | 'probing'

/** 进行中操作的实时进度（来自 machine.list 行的 progress 字段）。 */
export interface SshProgress {
  phase: SshProgressPhase
  attempt?: number
  total?: number
  log?: string
}

/** machine.save 的机器档案（与宿主 MachineProfile 契约对齐；敏感值走 secrets 另传）。 */
export interface SshMachineProfile {
  id: string
  name: string
  host: string
  port?: number
  user?: string
  remotePort?: number
  color?: string
  tintBorder?: boolean
  startCommand?: string
}

/** machine.save 的敏感字段：仅在保存时传输，任何状态不落库。 */
export interface SshSecrets {
  password?: string
  passphrase?: string
}

/** machine.events 返回的单条事件（seq 单调递增，增量轮询游标）。 */
export interface SshEventEntry {
  seq: number
  line: string
}

/**
 * `machine.list` 的应答信封（items = 手动机器，discovered = ~/.ssh/config 别名）。
 * `enabled` 为 SSH 功能开关：关闭时两侧机器行为空，壳层据此不渲染切换器。
 */
export interface SshMachineListValue {
  enabled?: boolean
  items: SshMachineRow[]
  discovered: SshMachineRow[]
}
