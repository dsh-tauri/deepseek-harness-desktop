import type { ContextMenuExtension } from '../types'
import type { ExtensionRegistry } from './registry.types'
import { sortBy } from 'dsh-tauri/client'
import { EXTENSIONS_REGISTRY_KEY } from '../constants'

const REGISTRY_KEY = Symbol.for(EXTENSIONS_REGISTRY_KEY)

/** Symbol 键索引的全局载体（避免给 globalThis 补任意索引签名）。 */
const globalStore = globalThis as typeof globalThis & Record<symbol, unknown>

/**
 * 取得（或首次创建）全局扩展注册表。注册表是插件间协议，挂在 Symbol.for 全局键上，
 * 不随 bundle 重载失效；租约归零且无条目时回收全局键。
 */
export function loadRegistry(): ExtensionRegistry {
  const existing = globalStore[REGISTRY_KEY] as ExtensionRegistry | undefined
  if (existing)
    return existing

  const entries = new Map<string, ContextMenuExtension>()
  let leases = 0

  const api: ExtensionRegistry = Object.freeze({
    register(entry: ContextMenuExtension): () => void {
      if (!entry?.id || entries.has(entry.id))
        throw new Error('invalid or duplicate context-menu extension')
      entries.set(entry.id, entry)
      return () => {
        entries.delete(entry.id)
        recycle()
      }
    },

    list(): ContextMenuExtension[] {
      return sortBy([...entries.values()], entry => entry.order ?? 0)
    },

    hold(): () => void {
      leases += 1
      return () => {
        leases -= 1
        recycle()
      }
    },
  })

  function recycle(): void {
    if (leases === 0 && entries.size === 0 && globalStore[REGISTRY_KEY] === api)
      delete globalStore[REGISTRY_KEY]
  }

  globalStore[REGISTRY_KEY] = api
  return api
}
