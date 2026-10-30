import type { ClientContext } from 'dsh-tauri/client'
import type { ConversationAttachments, DraftAttachmentDescriptor, DraftUploadState, DraftUploadWaitInput } from './attachments.types'
import { ATTACHMENT_READY_DELAY_MS, ATTACHMENT_READY_MAX_ATTEMPTS } from '../constants'

export function conversationAttachments(ctx: ClientContext): ConversationAttachments | undefined {
  try {
    const conversation = ctx.get('conversation') as ConversationAttachments | undefined
    return conversation ?? undefined
  }
  catch {
    return undefined
  }
}

export function captureDraftAttachments(
  conversation: ConversationAttachments | undefined,
  ids: readonly string[],
): readonly DraftAttachmentDescriptor[] {
  if (conversation === undefined || ids.length === 0 || typeof conversation.resolveDraftAttachments !== 'function')
    return []
  try {
    return conversation.resolveDraftAttachments(ids).filter(value => value?.file !== undefined)
  }
  catch {
    return []
  }
}

export function recreateDraftAttachments(
  conversation: ConversationAttachments | undefined,
  sessionId: string,
  captured: readonly DraftAttachmentDescriptor[],
): { ids: readonly string[], drafts: readonly { id: string }[] } {
  if (conversation === undefined || captured.length === 0 || typeof conversation.createDrafts !== 'function')
    return { ids: [], drafts: [] }
  try {
    const drafts = conversation.createDrafts(sessionId, captured.map(value => value.file as File))
    return { ids: drafts.map(draft => draft.id), drafts }
  }
  catch {
    return { ids: [], drafts: [] }
  }
}

export function mergeCapturedAttachments(
  fresh: readonly DraftAttachmentDescriptor[],
  previous: readonly DraftAttachmentDescriptor[],
  ids: readonly string[],
): readonly DraftAttachmentDescriptor[] {
  const merged = fresh.filter(item => ids.includes(item.id))
  for (const item of previous) {
    if (ids.includes(item.id) && !merged.some(value => value.id === item.id))
      merged.push(item)
  }
  return merged
}

export function releaseDraftAttachments(
  conversation: ConversationAttachments | undefined,
  attachments: readonly { id: string }[],
): void {
  if (conversation === undefined || attachments.length === 0 || typeof conversation.releaseDraftAttachments !== 'function')
    return
  try {
    conversation.releaseDraftAttachments(attachments)
  }
  catch {
  }
}

export async function awaitDraftUploads(input: DraftUploadWaitInput): Promise<void> {
  const uploads = input.conversation?.fileUploads
  if (input.ids.length === 0 || typeof uploads?.getSnapshot !== 'function')
    return
  const attempts = input.attempts ?? ATTACHMENT_READY_MAX_ATTEMPTS
  const delayMs = input.delayMs ?? ATTACHMENT_READY_DELAY_MS
  for (let attempt = 0; ; attempt++) {
    const snapshot = uploads.getSnapshot() ?? {}
    const states = input.ids
      .map(id => snapshot[id])
      .filter((state): state is DraftUploadState => state !== undefined)
    if (states.some(state => state.status === 'error'))
      throw new Error('消息附件上传失败，请重新发送')
    if (!states.some(state => state.status === 'uploading'))
      return
    if (attempt >= attempts)
      throw new Error('等待消息附件上传超时，请重新发送')
    await input.wait(delayMs)
  }
}
