import { useQuery } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { queryKeys } from '@/config/query-keys'

/** 是否为发行版仓库构建（Copr / AUR 等）：构建期常量，进程内不会变化 */
export const DISTRO_MANAGED_QUERY = {
  queryKey: queryKeys.distroManaged,
  queryFn: () => invoke<boolean>('is_desktop_distro_managed'),
  staleTime: Infinity,
}

export function useDistroManaged(): boolean {
  return useQuery(DISTRO_MANAGED_QUERY).data === true
}
