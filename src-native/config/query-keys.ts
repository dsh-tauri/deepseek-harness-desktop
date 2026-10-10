/**
 * React Query key 注册表：key 是查询方与失效方之间的共享契约。
 * 保持单元素 snake_case 数组，参数化 key 用展开组合（`[...queryKeys.x, id]`），
 * 与桌面端 `src/config/query-keys.ts` 约定一致。
 */
export const queryKeys = {
  hostsHealth: ['hosts_health'],
} as const
