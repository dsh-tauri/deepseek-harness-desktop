import type { SyncItemResult } from '../../types/index'

export function syncKeyOf(item: { kind: string, name: string, root?: string }): string {
  return `${item.kind}:${item.root ?? ''}:${item.name}`
}

export function toggleSelection(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected)
  if (next.has(key))
    next.delete(key)
  else
    next.add(key)
  return next
}

export function mergeSyncResults(previous: readonly SyncItemResult[], incoming: readonly SyncItemResult[]): SyncItemResult[] {
  const merged = [...previous]
  const at = new Map(merged.map((item, index) => [syncKeyOf(item), index]))
  for (const item of incoming) {
    const key = syncKeyOf(item)
    const index = at.get(key) ?? merged.length
    at.set(key, index)
    merged[index] = item
  }
  return merged
}
