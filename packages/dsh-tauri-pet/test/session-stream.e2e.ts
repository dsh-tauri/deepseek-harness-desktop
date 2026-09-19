/**
 * PP1：`dsh-tauri-pet` 的宿主 SSE 路由在真实 dsh 进程里可用。
 *
 * 断言对象是外部世界（HTTP 响应字节），不是插件的自我报告：连接建立后服务端
 * 立刻刷一帧注释（`get.ts` 的 pushComment），所以「收到 `:` 开头的一行」就是
 * 「路由已注册且 handler 跑起来了」的正向证据。
 *
 * 无浏览器：本用例只走 HTTP，先把编排骨架跑稳，客户端渲染留给 PP2。
 */

import { expect, inject, test } from 'vitest'

/** 与 `packages/dsh-tauri-pet/src/shared/constants.ts` 的 SESSION_STREAM_PATH 对齐。 */
const SESSION_STREAM_PATH = '/api/desktop/dsh-tauri-pet/session/stream'

/** 带超时地读一段响应体（SSE 永不结束，读满即中止）。 */
async function readChunk(response: Response, minimumChars: number, timeoutMs = 15_000): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined)
    throw new Error('响应没有 body 流')

  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + timeoutMs
  while (text.length < minimumChars) {
    if (Date.now() > deadline)
      throw new Error(`读取 SSE 首帧超时（${timeoutMs}ms）；已收到：${JSON.stringify(text)}`)
    const { value, done } = await reader.read()
    if (done)
      break
    text += decoder.decode(value, { stream: true })
  }
  await reader.cancel()
  return text
}

test('会话流路由连上后立刻下发就绪帧', async () => {
  const response = await fetch(`${inject('dshBaseUrl')}${SESSION_STREAM_PATH}`, {
    headers: { accept: 'text/event-stream' },
  })

  expect(response.status, 'SSE 路由必须存在且返回 200').toBe(200)
  expect(response.headers.get('content-type') ?? '', '必须是 text/event-stream').toContain('text/event-stream')

  const body = await readChunk(response, 4)
  expect(body, '接入即刷一帧注释帧（连接已就绪）').toMatch(/^:\s*keepalive/)
})

test('会话流路由拒绝未声明的方法', async () => {
  const response = await fetch(`${inject('dshBaseUrl')}${SESSION_STREAM_PATH}`, { method: 'POST', body: '{}' })
  expect(response.status, '只声明了 GET，POST 必须 405').toBe(405)
  expect(response.headers.get('allow') ?? '').toContain('GET')
})
