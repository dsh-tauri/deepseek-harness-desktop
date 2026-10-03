import * as SecureStore from 'expo-secure-store'
import { i18n } from '@/i18n'
import { connection } from './index'

function tokenKey(origin: string): string {
  const encoded = Array.from(origin, character => character.charCodeAt(0).toString(16).padStart(4, '0')).join('')
  return `dsh-bridge.token.${encoded}`
}

function reportStorageFailure() {
  const message = i18n.t('connection.storageFailed')
  if (connection.notice !== message)
    connection.setNotice(message)
}

/**
 * 启动时恢复连接记录：
 * 1. `connection.$persist.rehydrate()` 由 valtio-define persist 插件把 `{version, history, guidedHosts}`
 *    读回 state（AsyncStorage 适配器在 store 模块里）；
 * 2. 令牌永远只从 SecureStore 按 origin 派生键读取，绝不进 AsyncStorage；
 * 3. 最后 `markHydrated(tokens)` 才把 state 标记为可用（也是插件开始写盘的前提）。
 */
export async function restoreConnections(): Promise<void> {
  if (connection.hydrated)
    return
  await connection.$persist.rehydrate()
  const entries = await Promise.all(connection.history.map(async (entry) => {
    try {
      const token = await SecureStore.getItemAsync(tokenKey(entry.id))
      return [entry.id, token] as const
    }
    catch (error) {
      console.error('[connection] token restore failed:', error)
      reportStorageFailure()
      return [entry.id, null] as const
    }
  }))
  const tokens: Record<string, string> = {}
  for (const [id, token] of entries) {
    if (token)
      tokens[id] = token
  }
  connection.markHydrated(tokens)
}

/**
 * 令牌持久化：跟随 state 变化把 SecureStore 里的令牌写入/清理对齐。
 * 连接快照本身由 persist 插件落盘，这里只处理 SecureStore，且串行执行避免竞态。
 */
export function bindConnectionPersistence(): () => void {
  let writtenIds = new Set(connection.history.map(entry => entry.id))
  let lastPayload = ''
  let queue = Promise.resolve()
  return connection.$subscribe(() => {
    if (!connection.hydrated)
      return
    const retained = new Set(connection.history.map(entry => entry.id))
    if (connection.current)
      retained.add(connection.current.id)
    const tokens = Object.fromEntries(Object.entries(connection.tokens).filter(([id]) => retained.has(id)))
    const payload = JSON.stringify(tokens)
    if (payload === lastPayload)
      return
    lastPayload = payload
    queue = queue.then(async () => {
      for (const [id, token] of Object.entries(tokens))
        await SecureStore.setItemAsync(tokenKey(id), token)
      for (const id of writtenIds) {
        if (!retained.has(id))
          await SecureStore.deleteItemAsync(tokenKey(id))
      }
      writtenIds = retained
    }).catch((error) => {
      lastPayload = ''
      console.error('[connection] token save failed:', error)
      reportStorageFailure()
    })
  })
}
