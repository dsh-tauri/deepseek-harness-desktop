/**
 * shared/constants.ts — dsh-tauri-pet 宿主/客户端共享的协议常量。
 *
 * SSE 流路径与 Rust 消费端（`src-tauri/src/bridge/pet.rs` 的 `SESSION_STREAM_PATH`）
 * 逐字一致：改这里等于改协议，必须两侧同步。
 */

/** 插件名（诊断元数据、locale 命名空间与注册标识）。 */
export const PLUGIN_ID = 'dsh-tauri-pet'

/** 桌宠会话增量 SSE 流路径（Rust 按 `http://127.0.0.1:<DSH_WEB_PORT>` + 此路径订阅）。 */
export const SESSION_STREAM_PATH = '/api/tauri/pet/session/stream'

/** SSE 重连间隔提示（毫秒）。 */
export const SSE_RETRY_MS = 1000

/** SSE 心跳注释帧间隔（毫秒）：防止代理/空闲断连。 */
export const SSE_KEEPALIVE_MS = 15_000

/**
 * 「宿主累计态已丢弃」注释帧文本。
 *
 * 宿主侧逐会话状态只在**最后一个**消费者断开时丢弃。新消费者接入时若已无其他消费者，
 * 宿主状态必然是从零重建的，任何已展示的气泡都作废；此时下发这一帧（注释帧，不是
 * `data:` 帧，避免污染数据语义），消费端据此清空桌宠气泡。Rust 侧同名常量见
 * `src-tauri/src/bridge/pet.rs`。
 */
export const SSE_STATE_LOST_COMMENT = 'state-lost'
