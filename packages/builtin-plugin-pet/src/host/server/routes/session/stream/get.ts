import type { SessionStreamSink } from '../../../../types'
import { defineEventHandler, EventStream } from 'h3'
import { SSE_KEEPALIVE_MS, SSE_RETRY_MS, SSE_STATE_LOST_COMMENT } from '../../../../../shared/constants'
import { sessionStream } from '../../../../service/session-stream'

const SSE_KEEPALIVE_COMMENT = 'keepalive'

/**
 * GET /api/tauri/pet/session/stream — 桌宠会话增量 SSE 流。
 *
 * 帧格式与 Rust 消费端（`src-tauri/src/bridge/pet.rs`）逐字对齐：
 *   - 数据帧 `data: {"action":…,"payload":…}\n\n`；
 *   - 心跳注释帧 `: keepalive\n\n`（每 `SSE_KEEPALIVE_MS`）；
 *   - 状态作废注释帧 `: state-lost\n\n`：仅当接入时已无其他消费者（宿主累计态从零重建）
 *     才随首帧下发，消费端据此清空遗留气泡；
 *   - 重连提示 `retry: 1000` 只随**首帧**数据发出：h3 的 `EventStream` 不产生「只有字段、
 *     没有 data」的帧，而 Rust 端把空 `data:` 行也当作一帧 JSON 解析（失败即断流重连）。
 */
export default defineEventHandler((event) => {
  const stream = new EventStream(event)
  // 接入即刷一帧注释：Node 的 `writeHead` 不会单独把响应头写出去，若连接建立后长时间没有
  // 会话事件，客户端会一直拿不到响应头。注释帧被所有 SSE 客户端忽略，等价于「连接已就绪」。
  void stream.pushComment(SSE_KEEPALIVE_COMMENT)

  let retrySent = false
  let keepalive: ReturnType<typeof setInterval> | undefined
  let detach: (() => void) | undefined

  // 结束该连接：先注销消费者（同步丢弃累计态），再关闭响应。
  const finish = (): void => {
    if (keepalive !== undefined) {
      clearInterval(keepalive)
      keepalive = undefined
    }
    detach?.()
    detach = undefined
  }

  const sink: SessionStreamSink = {
    push(frame) {
      if (retrySent) {
        void stream.push({ data: frame })
        return
      }
      retrySent = true
      void stream.push({ retry: SSE_RETRY_MS, data: frame })
    },
    close() {
      finish()
      void stream.close()
    },
  }

  // 有消费者才开始监听会话总线（桌宠关闭时 Rust 不会连上来）。
  const { detach: release, stateLost } = sessionStream.start(sink)
  detach = release
  // 接入前已无其他消费者：宿主累计态是从零重建的，消费端手里的气泡全部作废。此刻用
  // 注释帧宣告（不能发 data: 帧——心跳之间不得出现数据帧，且注释帧对所有 SSE 客户端
  // 无害）。仍有其他消费者时宿主状态留存且不会重放，绝不能清。
  if (stateLost)
    void stream.pushComment(SSE_STATE_LOST_COMMENT)
  // 心跳注释帧，防止代理/空闲断连。
  keepalive = setInterval(() => {
    void stream.pushComment(SSE_KEEPALIVE_COMMENT)
  }, SSE_KEEPALIVE_MS)
  // 客户端断开（或插件卸载主动 close）时停心跳并注销本消费者；
  // 最后一个消费者断开即让会话总线的热路径彻底退出。
  stream.onClosed(finish)
  return stream
})
