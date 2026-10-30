import { useStore } from 'dsh-tauri/client'
import { useEffect } from 'react'
import { SKILL_CREATOR_DRAFT } from '../constants'
import { store } from '../store'

export interface InputActions {
  setDraft: (text: string) => void
}

export interface ConversationInputLeftProps {
  sessionId: string
  inputActions: InputActions
}

export function SkillCreatorPrefill({ sessionId, inputActions }: ConversationInputLeftProps): null {
  const { pendingSessionIds } = useStore(store.prefill)
  const pending = pendingSessionIds.includes(sessionId)
  useEffect(() => {
    if (!store.prefill.consume(sessionId))
      return
    inputActions.setDraft(SKILL_CREATOR_DRAFT)
  }, [pending, inputActions, sessionId])
  return null
}
