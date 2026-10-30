export interface DraftUploadState {
  status?: 'uploading' | 'ready' | 'error'
}

export interface DraftAttachmentDescriptor {
  id: string
  kind?: 'image' | 'file'
  file?: File
}

export interface ConversationAttachments {
  resolveDraftAttachments?: (ids: readonly string[]) => readonly DraftAttachmentDescriptor[]
  createDrafts?: (sessionId: string, files: readonly File[]) => readonly { id: string }[]
  releaseDraftAttachments?: (attachments: readonly { id: string }[]) => void
  fileUploads?: { getSnapshot: () => Record<string, DraftUploadState | undefined> }
}

export interface DraftUploadWaitInput {
  conversation?: ConversationAttachments
  ids: readonly string[]
  wait: (ms: number) => Promise<void>
  attempts?: number
  delayMs?: number
}
