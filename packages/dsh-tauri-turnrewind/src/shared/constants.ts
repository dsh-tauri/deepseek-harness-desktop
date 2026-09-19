/**
 * shared/constants.ts — 跨 host/client 的稳定协议常量。
 *
 * 插件名、API 前缀与「不可用原因」是两半端共享的线协议面：host 侧路由/账本写入、
 * client 侧 RPC/卡片呈现各自硬编码必然漂移，集中在此由两端共同引用
 * （agents.plugins.md「客户端常量集中规则」）。
 */

/** 插件名（诊断元数据 / registrant / 存储目录名）。 */
export const PLUGIN_ID = 'dsh-tauri-turnrewind'

/**
 * 会话 cwd 不在 Git worktree 内：不建快照。
 * 客户端据此把「撤销」按钮改为弹出「需要 Git 代码仓库」说明弹窗。
 */
export const TURNREWIND_REASON_GIT_REQUIRED = 'TURNREWIND_GIT_REQUIRED'

/**
 * PATH 上没有 git 可执行文件。与「不是 Git 仓库」必须分开：
 * 前者提示用户装 git，后者提示用户 git init，混在一起会给出错误指引。
 */
export const TURNREWIND_REASON_GIT_UNAVAILABLE = 'TURNREWIND_GIT_UNAVAILABLE'

/** 该 turn 的快照已被容量治理回收（超保留条数 / 仓库隔离重建 / 手工删除）。 */
export const TURNREWIND_REASON_EXPIRED = 'TURNREWIND_EXPIRED'

/** 该 turn 仍在运行中，after 快照尚未结算，此时不允许撤销。 */
export const TURNREWIND_REASON_TURN_ACTIVE = 'TURNREWIND_TURN_ACTIVE'

/**
 * 快照或统计过程失败（git 异常、仓库损坏、捕获子进程被中断等）。
 *
 * 与「超限」类原因（文件数/字节数）的区别在于**不可操作**：它说的是「我们没能
 * 把这一轮记下来」，而不是「这一轮超出撤销范围」。客户端据此对「连基线都没建立」
 * 的记录保持沉默（见 client/utils/format.ts）。
 */
export const TURNREWIND_REASON_SNAPSHOT_FAILED = 'TURNREWIND_SNAPSHOT_FAILED'

/** 撤销命中了不允许穿透的目标路径（父级符号链接/junction、非空目录占位）。 */
export const TURNREWIND_REASON_UNSAFE_PATH = 'TURNREWIND_UNSAFE_PATH'

/**
 * 工作区锁等待超时：由固定 loopback 端口的内核独占监听句柄串行（host/utils/lock.ts）。
 * 拿不到锁不代表本轮不能撤销，客户端应呈现为可重试的失败，而非终态错误。
 */
export const TURNREWIND_REASON_WORKSPACE_BUSY = 'TURNREWIND_WORKSPACE_BUSY'
