import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { queryKeys } from '@/config/query-keys'
import { useInvalidateOnSettingUpdated } from '@/hooks/use-invalidate-on-setting-updated'

/** Rust 侧 service::backup::BackupInfo 的序列化形态（camelCase） */
export interface BackupInfo {
  timestamp: string
  path: string
  size: number
  includeCredentials: boolean
}

export interface UseBackupsResult {
  backups: BackupInfo[]
  loading: boolean
  error: string
  createBackup: (includeCredentials: boolean) => Promise<BackupInfo>
  restoreBackup: (timestamp: string, asNew: boolean) => Promise<void>
  deleteBackup: (timestamp: string) => Promise<void>
  /** 任意操作进行中（统一禁用按钮用） */
  busy: boolean
  /** 仅创建备份进行中（用于「立即备份」按钮显示 loading） */
  creating: boolean
  /** 仅还原进行中 */
  restoring: boolean
  /** 仅删除进行中 */
  deleting: boolean
  exporting: boolean
  recoveryBackup: BackupInfo | undefined
  exportRecoveryBackup: (includeCredentials: boolean) => Promise<BackupInfo>
}

/**
 * 备份列表与操作（react-query）。
 *
 * 备份设置存在桌面端 store，`update_app_config` 会触发 `setting_updated` 事件，
 * 这里监听该事件一并失效重拉，保证列表与后端一致。
 */
export function useBackups(profileId: string): UseBackupsResult {
  const queryClient = useQueryClient()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.profileBackups(profileId),
    queryFn: () => invoke<BackupInfo[]>('list_backups', { profileId }),
  })

  // 后端设置变更（配置变化触发备份等）后刷新备份列表
  useInvalidateOnSettingUpdated(queryKeys.backups)

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.backups })
  }

  const create = useMutation({
    mutationFn: (includeCredentials: boolean) =>
      invoke<BackupInfo>('backup_profile', { profileId, includeCredentials }),
    onSuccess: invalidate,
  })
  const restore = useMutation({
    mutationFn: ({ timestamp, asNew }: { timestamp: string, asNew: boolean }) =>
      invoke<void>('restore_profile', { profileId, timestamp, asNew }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (timestamp: string) => invoke<void>('delete_backup', { profileId, timestamp }),
    onSuccess: invalidate,
  })
  const recovery = useMutation({
    mutationFn: (includeCredentials: boolean) =>
      invoke<BackupInfo>('export_recovery_backup', { includeCredentials }),
  })
  return {
    backups: data ?? [],
    loading: isLoading,
    error: error ? String(error) : '',
    createBackup: async (includeCredentials) => {
      const created = await create.mutateAsync(includeCredentials)
      await refetch()
      return created
    },
    restoreBackup: async (timestamp, asNew) => {
      await restore.mutateAsync({ timestamp, asNew })
      await refetch()
    },
    deleteBackup: async (timestamp) => {
      await remove.mutateAsync(timestamp)
      await refetch()
    },
    busy: create.isPending || restore.isPending || remove.isPending || recovery.isPending,
    creating: create.isPending,
    restoring: restore.isPending,
    deleting: remove.isPending,
    exporting: recovery.isPending,
    recoveryBackup: recovery.data,
    exportRecoveryBackup: recovery.mutateAsync,
  }
}
