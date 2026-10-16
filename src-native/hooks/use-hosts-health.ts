import { useQuery } from '@tanstack/react-query'
import { useStore } from 'valtio-define'
import { HEALTH_INTERVAL_MS } from '@/config/constants'
import { queryKeys } from '@/config/query-keys'
import { connection } from '@/store/modules/connection'
import { refreshHealth } from '@/store/modules/connection/runtime'

/**
 * 轮询已保存主机的可用性：定时器、并发去重与回前台重取都交给 React Query，
 * 因此入参只需要「是否已恢复连接记录」这一个门控。
 * `refreshHealth()` 仍是那次探测本身（写 health、发离线通知），手动刷新按钮继续直接调用它。
 * 查询函数必须返回非 `undefined`（React Query 会对 `undefined` 结果告警），故显式返回 `null`。
 */
export function useHostsHealth(): void {
  const { hydrated } = useStore(connection)
  useQuery({
    queryKey: queryKeys.hostsHealth,
    queryFn: async () => {
      await refreshHealth()
      return null
    },
    enabled: hydrated,
    refetchInterval: HEALTH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  })
}
