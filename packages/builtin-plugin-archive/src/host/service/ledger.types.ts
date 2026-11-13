export interface ArchivedListPayload {
  archivedSessionIds: string[]
  meta: Record<string, { createdAt?: number, cwd?: string, title?: string }>
}
