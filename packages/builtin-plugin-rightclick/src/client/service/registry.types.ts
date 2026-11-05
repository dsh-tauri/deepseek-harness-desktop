import type { ContextMenuExtension } from '../types'

/** 插件间协议面：其他 Web 插件经 globalThis 登记扩展项，插件实例以租约保活。 */
export interface ExtensionRegistry {
  register: (entry: ContextMenuExtension) => () => void
  list: () => ContextMenuExtension[]
  hold: () => () => void
}
