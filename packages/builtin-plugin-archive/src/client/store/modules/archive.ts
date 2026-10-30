import type { ArchiveSort, ArchiveState } from './archive.types'
import { defineStore } from 'dsh-tauri/client'

export const archive = defineStore({
  state: (): ArchiveState => ({
    archived: { archivedSessionIds: [], meta: {} },
    sort: 'updatedAt',
    query: '',
    workspaceId: 'all',
    loading: false,
    pending: false,
    error: '',
    suppressedSessionIds: [],
    titleById: {},
    refreshGeneration: 0,
  }),
  actions: {
    setSort(sort: ArchiveSort) {
      this.sort = sort
    },
    setQuery(query: string) {
      this.query = query
    },
    setWorkspaceFilter(workspaceId: string) {
      this.workspaceId = workspaceId
    },
    beginRefresh(): number {
      this.refreshGeneration += 1
      return this.refreshGeneration
    },
    isCurrentRefresh(generation: number): boolean {
      return generation === this.refreshGeneration
    },
    mergeTitles(titles: Record<string, string>) {
      if (Object.entries(titles).every(([id, title]) => this.titleById[id] === title))
        return
      this.titleById = { ...this.titleById, ...titles }
    },
  },
})
