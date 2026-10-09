import { PLUGIN_ID } from './shared/constants'

export const name = PLUGIN_ID

/** 宿主服务依赖：`webServer`（注册路由）与 `connection`（路由鉴权闸门，注册期必需）。 */
export const inject = ['webServer', 'connection']

/**
 * 宿主半边只负责回答一个问题：这个会话的回合为什么结束。
 *
 * 客户端能看到的状态只有 `running: boolean`（`sessions.list` 与 `uiSession.sessionStatus`
 * 都只有这一个维度），分不出「正常跑完」和「用户手动中断」；`turn/end` 的 `reason.kind`
 * 只出现在宿主事件里。因此宿主订阅 `session/event`、把最近一次结束原因按会话记在内存里，
 * 再用 `GET /api/tauri/notification/turn-end` 暴露给客户端。
 *
 * 通知的其它数据（标题、待处理的授权/提问）仍然只存在于客户端服务里：本插件不注册
 * 会话投影（`@deepseek-ai/dsh-session-projection` 不在本仓库依赖内），也不新增推送通道。
 */
export { apply } from './host/apply'
