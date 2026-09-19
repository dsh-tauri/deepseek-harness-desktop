import type { ParentMessage, ParentMessageContext, ParentMessageTypes } from '../types/iframe'
import type { UnlistenFn } from '../types/tauri'

/** `type` 过滤：字符串精确匹配，数组按成员匹配。 */
function matchesType(type: string | undefined, types: ParentMessageTypes): boolean {
  return typeof types === 'string' ? type === types : types.includes(type ?? '')
}

/**
 * 监听主窗口（宿主）发来的消息 —— iframe 侧**收消息的唯一入口**。
 *
 * 只做安全相关的两道校验：
 * 1. `event.source === window.parent`：宿主是本 iframe 唯一的直接父窗口，兄弟 iframe
 *    或页面内第三方脚本无法伪造该 source；
 * 2. 可选 `types` 过滤：按 `type` 分发（宿主侧已不比对 `source`，客户端同样只认 `type`）。
 *
 * 所有自定义桥（导航、错误上报、插件自有协议）都必须经本函数收消息，
 * 不要各自写 `window.addEventListener('message', …)`。
 *
 * 参数序与桌面宿主侧契约一致：`(handler, types?)`（见 `docs/specs/agents.plugins.md` 的父窗口桥表）。
 * 不要把 `types` 放到第一位——它既与文档相悖，也会让「按 type 过滤」在传数组时静默失效。
 *
 * @returns 取消监听的函数（与 `@tauri-apps/api/event` 的 `listen` 返回形态一致）
 */
export function listenParent<T extends ParentMessage>(
  handler: (message: T, context: ParentMessageContext) => void,
  types?: ParentMessageTypes,
): UnlistenFn {
  function onMessage(event: MessageEvent<unknown>): void {
    if (event.source !== window.parent)
      return
    const data = event.data
    if (!data || typeof data !== 'object')
      return
    const message = data as ParentMessage
    if (types !== undefined && !matchesType(message.type, types))
      return
    handler(message as T, { event })
  }

  window.addEventListener('message', onMessage)
  return () => {
    window.removeEventListener('message', onMessage)
  }
}
