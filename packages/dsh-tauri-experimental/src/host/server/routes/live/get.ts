/**
 * GET /api/tauri/experimental/live — 运行中实时读数（客户端提示条轮询）。
 *
 * 宿主侧读数由 capture 编排器定时刷新到内存，本路由只读缓存值：
 * 客户端轮询频率因此与 git 调用频率解耦（大仓库不会因为轮询而反复跑 git）。
 */

import type { LiveSnapshot } from '../../../types'
import { defineEventHandler, getQuery } from 'h3'
import { capture } from '../../../service/capture'

export default defineEventHandler((event): LiveSnapshot | { error: string } => {
  const query = getQuery<{ sessionId?: string }>(event)
  const sessionId = typeof query.sessionId === 'string' ? query.sessionId : ''
  if (sessionId.length === 0) {
    event.res.status = 400
    return { error: '缺少 sessionId' }
  }
  return capture.live(sessionId)
})
