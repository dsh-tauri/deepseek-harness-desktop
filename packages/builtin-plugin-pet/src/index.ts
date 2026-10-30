import { PLUGIN_ID } from './shared/constants'

export const name = PLUGIN_ID

/** 需要的宿主服务：webServer（SSE 路由）、sessions（session/event 总线）、connection（路由工具的连接信任边界）、workspaceRegistry（归档集合）。 */
export const inject = ['webServer', 'sessions', 'connection', 'workspaceRegistry']

export { apply } from './host/apply'

/** SSE 流路径（Rust 消费端按 `http://127.0.0.1:<DSH_WEB_PORT>` + 此路径订阅）。 */
export { SESSION_STREAM_PATH } from './shared/constants'
