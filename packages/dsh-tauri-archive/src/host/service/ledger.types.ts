/** `GET /api/tauri/archive/session/archive` 的线上载荷。 */
export interface ArchivedListPayload {
  archivedSessionIds: string[]
  meta: Record<string, { createdAt?: number, cwd?: string, title?: string }>
}

/** 归档集合的记账方向：删除会话从工作区记账摘除，取消归档修复历史缺失的槽位。 */
export type ArchiveAccounting = 'detach' | 'attach'
