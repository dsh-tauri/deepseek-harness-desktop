import type { GetApiTauriArchiveSessionArchiveResponse as ArchivedListPayload } from '../../apis/index.type'

/** 归档页排序方式，同时作用于「组」与「组内聊天」（更新时间 / 创建时间 / 标题）。 */
export type ArchiveSort = 'updatedAt' | 'createdAt' | 'title'

export interface ArchiveState {
  archived: ArchivedListPayload
  sort: ArchiveSort
  query: string
  /** 选中的项目筛选；`all` 显示全部组。 */
  workspaceId: string
  loading: boolean
  /** 破坏性/恢复变更在途（驱动禁用与 loading toast）。 */
  pending: boolean
  error: string
  /** 取消归档/删除成功后乐观隐藏的 id，直到宿主镜像追上。 */
  suppressedSessionIds: string[]
  /** 会话从筛选列表消失前观测到的标题（保证幽灵行仍有可展示标题）。 */
  titleById: Record<string, string>
  /** 归档刷新代数：并发保护，只允许最新一次响应写回。 */
  refreshGeneration: number
}
