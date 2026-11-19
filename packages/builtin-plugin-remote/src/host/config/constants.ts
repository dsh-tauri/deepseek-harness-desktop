export const EVENT_RING_CAPACITY = 500

export const DEFAULT_REMOTE_PROFILE = 'remote'

export const DEFAULT_MACHINE_TRANSPORT = 'ssh'

export const REMOTE_ROOT = '.dsh-desktop'

/** 远端脚本的日志行前缀：桌面端按它把远端脚本的输出认成事件。 */
export const BOOTSTRAP_LOG_PREFIX = '::dsh '

/**
 * 远端实例的 pidfile：按端口区分。
 *
 * 实例身份是「主机 + 端口」：一个端口上只可能有一个实例。按档案再分一份 pidfile
 * 会让同一端口上的两份 pidfile 指向不同实例，后续按 pidfile 做的判断（读 pid、
 * 核对命令行）就会落到错的进程上。issue #1574。
 */
export function remotePidfile(port: number): string {
  return `.dsh/.dsh-remote-${port}.pid`
}

/** 内部来源标识的两枚头名（S2 §9）；网关注入侧与插件判定侧必须逐字一致。 */
export const GATEWAY_SOURCE_HEADER = 'x-dsh-remote-source'

export const GATEWAY_SESSION_HEADER = 'x-dsh-remote-session'
