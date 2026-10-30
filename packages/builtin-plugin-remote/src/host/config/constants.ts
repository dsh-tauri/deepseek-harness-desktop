export const EVENT_RING_CAPACITY = 500

export const DEFAULT_REMOTE_PROFILE = 'remote'

export const DEFAULT_MACHINE_TRANSPORT = 'ssh'

export const REMOTE_ROOT = '.dsh-desktop'

/** 内部来源标识的两枚头名（S2 §9）；网关注入侧与插件判定侧必须逐字一致。 */
export const GATEWAY_SOURCE_HEADER = 'x-dsh-remote-source'

export const GATEWAY_SESSION_HEADER = 'x-dsh-remote-session'
