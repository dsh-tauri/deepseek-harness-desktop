import { useStore } from 'dsh-tauri/client'
import { useEffect } from 'react'
import { store } from '../store'

/** conversation.input.left 槽位注入给草稿组件的属性。 */
export interface ConversationInputLeftProps {
  inputActions: {
    setDraft: (text: string) => void
  }
  sessionId: string
}

/**
 * 新建桌宠会话后把 /hatch 提示词一次性填入输入框（取出即消费）。
 *
 * 必须订阅 store 而不能在挂载时读一次：`createPetSession` 走官方 `connectWorkspace`，
 * 后者会复用已打开的空白会话并原样返回其 id，此时本组件早已挂载，`sessionId` 与
 * `inputActions`（每会话稳定标识）都不变——只依赖这两个值的话 effect 永不重跑，
 * 晚到的草稿会一直滞留在 store 里（表现为「切走再切回来才出现」）。
 * 订阅范式与 `dsh-tauri-scheduler` 的 `PrefillBridge` 一致。
 */
export function PetPrefill({ sessionId, inputActions }: ConversationInputLeftProps): null {
  const { prefills } = useStore(store.pet)
  const draft = prefills[sessionId]
  useEffect(() => {
    const taken = store.pet.takePrefill(sessionId)
    if (taken === undefined)
      return
    inputActions.setDraft(taken)
  }, [draft, inputActions, sessionId])
  return null
}
