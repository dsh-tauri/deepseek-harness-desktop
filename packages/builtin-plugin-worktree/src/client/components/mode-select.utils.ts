import type { InputActions, InputState, SessionDraft, SessionInputRuntime } from '../service/session-switch.types'
import type { WorktreeSessionState } from '../store/modules/worktree.types'

export const NO_DRAFT_ATTACHMENTS: readonly string[] = []

export function restoreSessionDraft(actions: InputActions, draft: SessionDraft, input?: SessionInputRuntime): void {
  if (draft.references.length > 0) {
    if (input?.draftSnapshot === undefined)
      throw new Error('无法迁移消息引用到工作树会话')
    input.setDraft(draft)
  }
  else {
    actions.setDraft(draft.text)
  }
  actions.persistDraft?.()
}

export function showsModeSelect(state: Pick<WorktreeSessionState, 'isGit' | 'mode'>): boolean {
  return state.isGit === true && state.mode !== 'worktree'
}

export function interceptsSubmit(state: Pick<WorktreeSessionState, 'isGit' | 'mode'>): boolean {
  return state.mode === 'pending' && state.isGit === true
}

export function hasSendableContent(draft: string, attachmentIds: readonly string[]): boolean {
  return draft.trim() !== '' || attachmentIds.length > 0
}

export function draftAttachmentIds(state: InputState | undefined): readonly string[] {
  return state?.attachmentIds ?? state?.imageIds ?? NO_DRAFT_ATTACHMENTS
}

export function canAddDraftAttachments(actions: InputActions | undefined): boolean {
  return typeof actions?.addAttachments === 'function' || typeof actions?.addImages === 'function'
}

export function addDraftAttachments(actions: InputActions | undefined, ids: readonly string[]): boolean {
  if (ids.length === 0)
    return true
  if (typeof actions?.addAttachments === 'function')
    return actions.addAttachments([...ids])
  if (typeof actions?.addImages === 'function')
    return actions.addImages([...ids])
  return false
}

export function removeDraftAttachment(actions: InputActions | undefined, id: string): void {
  if (typeof actions?.removeAttachment === 'function') {
    actions.removeAttachment(id)
    return
  }
  actions?.removeImage?.(id)
}

export function resolveAccessModeGroup(button: HTMLElement, planSlot: Element | null, maxDepth = 8): HTMLElement {
  let previous: HTMLElement = button
  let node: HTMLElement | null = button.parentElement
  for (let depth = 0; node && depth < maxDepth; depth++) {
    if (planSlot ? node.contains(planSlot) : previous !== button)
      return node
    previous = node
    node = node.parentElement
  }
  return button
}
