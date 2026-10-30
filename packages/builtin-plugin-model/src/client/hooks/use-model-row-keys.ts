import { useId, useState } from 'react'

export function useModelRowKeys(models: readonly Record<string, unknown>[]): readonly string[] {
  const prefixId = useId()
  const [rows, setRows] = useState(() => ({ models, keys: models.map((_, index) => `${prefixId}-${index}`), next: models.length }))
  if (rows.models === models)
    return rows.keys

  const used = new Set<number>()
  const keys = models.map((model) => {
    const previous = rows.models.findIndex((row, index) => row === model && !used.has(index))
    if (previous < 0)
      return undefined
    used.add(previous)
    return rows.keys[previous]
  })
  for (const [index, model] of models.entries()) {
    if (keys[index] !== undefined)
      continue
    const previous = rows.models.findIndex((row, at) => typeof model.id === 'string' && row.id === model.id && !used.has(at))
    if (previous >= 0) {
      used.add(previous)
      keys[index] = rows.keys[previous]
    }
  }
  let nextId = rows.next
  const next = keys.map((key, index) => {
    if (key !== undefined)
      return key
    if (rows.keys[index] !== undefined && !used.has(index)) {
      used.add(index)
      return rows.keys[index]
    }
    return `${prefixId}-${nextId++}`
  })
  setRows({ models, keys: next, next: nextId })
  return next
}
